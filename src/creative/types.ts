/**
 * Types for the creative generator module
 */

export interface CreativeInput {
  description: string;
  imageUrls?: string[];
  referenceUrl?: string;
}

export interface ImagePrompt {
  prompt: string;
  negativePrompt?: string;
  style?: string;
  aspectRatio?: string;
  seedValue?: number;
}

export interface CreativeSession {
  id: string;
  input: CreativeInput;
  currentPrompt: ImagePrompt;
  history: CreativeEdit[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreativeEdit {
  instruction: string;
  previousPrompt: ImagePrompt;
  newPrompt: ImagePrompt;
  timestamp: Date;
}

export interface CreativeGenerator {
  createSession(input: CreativeInput): Promise<CreativeSession>;
  generatePrompt(session: CreativeSession): Promise<ImagePrompt>;
  editPrompt(session: CreativeSession, instruction: string): Promise<ImagePrompt>;
  getSession(id: string): Promise<CreativeSession | null>;
}