# TODO: Update URLs and SHA256 values after the first GitHub release.

class KondiChat < Formula
  desc "Multi-model AI coding CLI with intelligent routing and council deliberation"
  homepage "https://github.com/kondi/kondi-chat"
  version "0.1.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/kondi/kondi-chat/releases/download/v0.1.0/kondi-chat-0.1.0-darwin-arm64.tar.gz"
      sha256 "TODO_FILL_AFTER_RELEASE" # TODO: replace with actual sha256
    else
      url "https://github.com/kondi/kondi-chat/releases/download/v0.1.0/kondi-chat-0.1.0-darwin-x64.tar.gz"
      sha256 "TODO_FILL_AFTER_RELEASE" # TODO: replace with actual sha256
    end
  end

  on_linux do
    url "https://github.com/kondi/kondi-chat/releases/download/v0.1.0/kondi-chat-0.1.0-linux-x64.tar.gz"
    sha256 "TODO_FILL_AFTER_RELEASE" # TODO: replace with actual sha256
  end

  depends_on "node"

  def install
    bin.install "bin/kondi-tui" => "kondi-chat" if File.exist?("bin/kondi-tui")
    libexec.install "src", "package.json", "bin/kondi-chat.js"

    if !File.exist?("bin/kondi-tui")
      (bin/"kondi-chat").write <<~SH
        #!/bin/bash
        exec node "#{libexec}/bin/kondi-chat.js" "$@"
      SH
    end
  end

  test do
    assert_match "kondi-chat", shell_output("#{bin}/kondi-chat --version")
  end
end
