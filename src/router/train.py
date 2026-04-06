#!/usr/bin/env python3
"""
Train a lightweight neural network router from kondi-chat routing data.

Consumes the JSONL training data collected by the orchestrator's rule-based
router and trains an NN that predicts which model will succeed for a given
task. The orchestrator is the teacher; this NN is the student.

Usage:
  python src/router/train.py [--data-dir .kondi-chat] [--out router_model.json]

The trained model is exported as JSON (weights + config) so it can be
loaded in TypeScript without a Python runtime.
"""

import json
import sys
import argparse
from pathlib import Path
import numpy as np

# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_samples(data_dir: str) -> list[dict]:
    """Load routing samples from the collector's JSONL file."""
    path = Path(data_dir) / "routing-data.jsonl"
    if not path.exists():
        print(f"No routing data found at {path}")
        sys.exit(1)

    samples = []
    for line in path.read_text().splitlines():
        if line.strip():
            samples.append(json.loads(line))

    print(f"Loaded {len(samples)} routing samples")
    return samples


def encode_features(samples: list[dict]) -> tuple[np.ndarray, dict]:
    """
    Encode samples into feature vectors. Features are dynamically
    discovered from the data — no hardcoded categories.

    If samples have embeddings, they are concatenated with structured
    features: [embedding(768D) | phase_onehot | kind_onehot | scalars]

    Returns (feature_matrix, feature_info) where feature_info contains
    the encoding schema needed for inference.
    """
    # Discover categories from data
    phases = sorted(set(s["phase"] for s in samples))
    task_kinds = sorted(set(s.get("taskKind") or "none" for s in samples))

    # Check for embeddings
    samples_with_embeddings = [s for s in samples if s.get("embedding")]
    has_embeddings = len(samples_with_embeddings) > len(samples) * 0.5  # Need >50%
    embedding_dim = 0

    if has_embeddings:
        embedding_dim = len(samples_with_embeddings[0]["embedding"])
        print(f"Using embeddings: {embedding_dim}D ({len(samples_with_embeddings)}/{len(samples)} samples)")
    else:
        if samples_with_embeddings:
            print(f"Too few embeddings ({len(samples_with_embeddings)}/{len(samples)}), using structured features only")
        else:
            print("No embeddings found, using structured features only")

    structured_names = (
        [f"phase:{p}" for p in phases] +
        [f"kind:{k}" for k in task_kinds] +
        ["prompt_length", "context_tokens", "failures"]
    )

    feature_names = (
        ([f"emb_{i}" for i in range(embedding_dim)] if has_embeddings else []) +
        structured_names
    )

    features = []
    for s in samples:
        # Structured features
        phase_vec = [1 if p == s["phase"] else 0 for p in phases]
        kind_vec = [1 if k == (s.get("taskKind") or "none") else 0 for k in task_kinds]
        prompt_norm = min(s.get("promptLength", 0) / 10_000, 1.0)
        context_norm = min(s.get("contextTokens", 0) / 100_000, 1.0)
        failure_norm = min(s.get("failures", 0) / 5.0, 1.0)
        structured = phase_vec + kind_vec + [prompt_norm, context_norm, failure_norm]

        if has_embeddings:
            emb = s.get("embedding") or [0.0] * embedding_dim
            features.append(emb + structured)
        else:
            features.append(structured)

    feature_info = {
        "phases": phases,
        "taskKinds": task_kinds,
        "featureNames": feature_names,
        "inputDim": len(feature_names),
        "embeddingDim": embedding_dim,
        "hasEmbeddings": has_embeddings,
    }

    return np.array(features, dtype=np.float32), feature_info


def encode_labels(samples: list[dict], model_names: list[str]) -> np.ndarray:
    """
    Encode labels: for each sample, 1 if the model succeeded, 0 if it
    failed, -1 if we don't know (model wasn't tried on this sample).
    """
    labels = []
    for s in samples:
        row = []
        for name in model_names:
            if s["modelId"] == name:
                row.append(1.0 if s.get("succeeded", False) else 0.0)
            else:
                row.append(-1.0)  # Unknown — exclude from loss
        labels.append(row)
    return np.array(labels, dtype=np.float32)


# ---------------------------------------------------------------------------
# Neural Network (numpy only — no PyTorch dependency)
# ---------------------------------------------------------------------------

def relu(x: np.ndarray) -> np.ndarray:
    return np.maximum(0, x)

def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-np.clip(x, -500, 500)))

def relu_derivative(x: np.ndarray) -> np.ndarray:
    return (x > 0).astype(np.float32)


class SimpleNN:
    """
    Multi-layer neural network trained with backprop.
    No PyTorch needed — pure numpy for minimal dependencies.
    """

    def __init__(self, layer_dims: list[int]):
        """layer_dims: [input_dim, hidden1, hidden2, ..., output_dim]"""
        self.weights: list[np.ndarray] = []
        self.biases: list[np.ndarray] = []
        for i in range(len(layer_dims) - 1):
            # Xavier initialization
            scale = np.sqrt(2.0 / layer_dims[i])
            self.weights.append(np.random.randn(layer_dims[i], layer_dims[i + 1]).astype(np.float32) * scale)
            self.biases.append(np.zeros(layer_dims[i + 1], dtype=np.float32))

    def forward(self, x: np.ndarray) -> np.ndarray:
        """Forward pass. Hidden layers use ReLU, output uses sigmoid."""
        self._activations = [x]
        self._pre_activations = []
        for i, (w, b) in enumerate(zip(self.weights, self.biases)):
            z = x @ w + b
            self._pre_activations.append(z)
            if i < len(self.weights) - 1:
                x = relu(z)
            else:
                x = sigmoid(z)
            self._activations.append(x)
        return x

    def backward(self, y_true: np.ndarray, mask: np.ndarray, lr: float = 0.001):
        """
        Backprop with masked loss (ignore samples where mask == 0).
        mask: same shape as y_true, 1 where we have labels, 0 where unknown.
        """
        n = max(mask.sum(), 1)
        y_pred = self._activations[-1]

        # Output gradient (BCE with mask)
        delta = (y_pred - y_true) * mask / n

        for i in range(len(self.weights) - 1, -1, -1):
            a_prev = self._activations[i]
            dw = a_prev.T @ delta
            db = delta.sum(axis=0)

            self.weights[i] -= lr * dw
            self.biases[i] -= lr * db

            if i > 0:
                delta = (delta @ self.weights[i].T) * relu_derivative(self._pre_activations[i - 1])

    def predict(self, x: np.ndarray) -> np.ndarray:
        return self.forward(x)

    def to_json(self) -> dict:
        """Export weights as JSON-serializable dict."""
        return {
            "weights": [w.tolist() for w in self.weights],
            "biases": [b.tolist() for b in self.biases],
            "layerDims": [self.weights[0].shape[0]] + [w.shape[1] for w in self.weights],
        }

    @classmethod
    def from_json(cls, data: dict) -> "SimpleNN":
        dims = data["layerDims"]
        nn = cls(dims)
        nn.weights = [np.array(w, dtype=np.float32) for w in data["weights"]]
        nn.biases = [np.array(b, dtype=np.float32) for b in data["biases"]]
        return nn


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def train(
    X: np.ndarray,
    Y: np.ndarray,
    model_names: list[str],
    hidden_dims: list[int] = [64, 32],
    epochs: int = 200,
    lr: float = 0.005,
    val_split: float = 0.15,
) -> tuple[SimpleNN, dict]:
    """Train the router NN and return (model, metrics)."""

    # Train/val split
    n = len(X)
    idx = np.random.permutation(n)
    val_n = int(n * val_split)
    val_idx, train_idx = idx[:val_n], idx[val_n:]

    X_train, X_val = X[train_idx], X[val_idx]
    Y_train, Y_val = Y[train_idx], Y[val_idx]

    # Mask: 1 where we have labels, 0 where unknown (-1)
    mask_train = (Y_train >= 0).astype(np.float32)
    mask_val = (Y_val >= 0).astype(np.float32)

    # Replace -1 with 0 for computation (masked out anyway)
    Y_train_clean = np.maximum(Y_train, 0)
    Y_val_clean = np.maximum(Y_val, 0)

    input_dim = X.shape[1]
    output_dim = Y.shape[1]
    layer_dims = [input_dim] + hidden_dims + [output_dim]

    nn = SimpleNN(layer_dims)
    best_val_loss = float("inf")
    best_weights = None
    patience = 20
    patience_counter = 0

    print(f"\nTraining: {len(X_train)} train, {len(X_val)} val")
    print(f"Architecture: {layer_dims}")
    print(f"Models: {model_names}\n")

    for epoch in range(epochs):
        # Forward + backward on train
        pred = nn.forward(X_train)
        nn.backward(Y_train_clean, mask_train, lr=lr)

        if (epoch + 1) % 20 == 0 or epoch == 0:
            # Compute masked BCE loss on validation
            val_pred = nn.predict(X_val)
            eps = 1e-8
            bce = -(Y_val_clean * np.log(val_pred + eps) + (1 - Y_val_clean) * np.log(1 - val_pred + eps))
            val_loss = (bce * mask_val).sum() / max(mask_val.sum(), 1)

            print(f"  Epoch {epoch + 1:4d}/{epochs}: val_loss={val_loss:.4f}")

            if val_loss < best_val_loss:
                best_val_loss = val_loss
                best_weights = ([w.copy() for w in nn.weights], [b.copy() for b in nn.biases])
                patience_counter = 0
            else:
                patience_counter += 1
                if patience_counter >= patience:
                    print(f"  Early stopping at epoch {epoch + 1}")
                    break

    # Restore best weights
    if best_weights:
        nn.weights, nn.biases = best_weights

    # Evaluate
    val_pred = nn.predict(X_val)
    metrics = evaluate(val_pred, Y_val, mask_val, model_names)

    return nn, metrics


def evaluate(
    pred: np.ndarray,
    y_true: np.ndarray,
    mask: np.ndarray,
    model_names: list[str],
) -> dict:
    """Evaluate the trained model."""
    results = {}

    for i, name in enumerate(model_names):
        m = mask[:, i] > 0
        if m.sum() == 0:
            continue
        y = y_true[m, i]
        p = pred[m, i]
        preds = (p >= 0.5).astype(float)
        acc = (preds == y).mean()
        results[name] = {
            "accuracy": float(acc),
            "samples": int(m.sum()),
            "positive_rate": float(y.mean()),
        }

    # System accuracy: pick model with highest predicted prob
    chosen_idx = np.argmax(pred, axis=1)
    # Only count where we have a label for the chosen model
    correct = 0
    counted = 0
    for i in range(len(pred)):
        ci = chosen_idx[i]
        if mask[i, ci] > 0:
            correct += y_true[i, ci]
            counted += 1

    results["_system"] = {
        "accuracy": float(correct / max(counted, 1)),
        "evaluated": int(counted),
    }

    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Train kondi-chat routing NN")
    parser.add_argument("--data-dir", default=".kondi-chat", help="Directory with routing-data.jsonl")
    parser.add_argument("--out", default=".kondi-chat/router-model.json", help="Output model path")
    parser.add_argument("--hidden", default="auto", help="Hidden layer dimensions (comma-separated, or 'auto')")
    parser.add_argument("--epochs", type=int, default=200)
    parser.add_argument("--lr", type=float, default=0.005)
    args = parser.parse_args()

    # Load and encode data
    samples = load_samples(args.data_dir)
    model_names = sorted(set(s["modelId"] for s in samples))

    if len(model_names) < 2:
        print(f"Need samples from at least 2 models to train. Found: {model_names}")
        sys.exit(1)

    X, feature_info = encode_features(samples)
    Y = encode_labels(samples, model_names)

    print(f"Features: {X.shape[1]} dimensions")
    print(f"Models to route between: {model_names}")

    for i, name in enumerate(model_names):
        known = (Y[:, i] >= 0).sum()
        positive = (Y[:, i] == 1).sum()
        print(f"  {name}: {known} samples, {positive} successes ({positive/max(known,1)*100:.0f}%)")

    # Train
    if args.hidden == "auto":
        # Auto-size: larger hidden layers when embeddings are present
        if feature_info.get("hasEmbeddings"):
            hidden_dims = [256, 128]
        else:
            hidden_dims = [64, 32]
        print(f"Auto-selected hidden dims: {hidden_dims}")
    else:
        hidden_dims = [int(x) for x in args.hidden.split(",")]
    nn, metrics = train(X, Y, model_names, hidden_dims=hidden_dims, epochs=args.epochs, lr=args.lr)

    # Print results
    print("\nResults:")
    print("=" * 60)
    for name, m in metrics.items():
        if name == "_system":
            print(f"  System accuracy: {m['accuracy']:.3f} ({m['evaluated']} samples)")
        else:
            print(f"  {name:35s}: acc={m['accuracy']:.3f} (n={m['samples']}, pos_rate={m['positive_rate']:.2f})")

    # Export
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    model_data = {
        "nn": nn.to_json(),
        "featureInfo": feature_info,
        "modelNames": model_names,
        "metrics": metrics,
        "trainedAt": str(np.datetime64("now")),
        "sampleCount": len(samples),
    }

    out_path.write_text(json.dumps(model_data, indent=2))
    print(f"\nModel saved to {out_path}")
    print(f"Load in TypeScript with: JSON.parse(readFileSync('{out_path}', 'utf-8'))")


if __name__ == "__main__":
    main()
