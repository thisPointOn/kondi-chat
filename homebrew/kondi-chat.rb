# TODO: Replace SHA256 placeholders with actual values after the first GitHub release.

class KondiChat < Formula
  desc "Multi-model AI coding CLI with intelligent routing and council deliberation"
  homepage "https://github.com/thisPointOn/kondi-chat"
  version "0.1.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/thisPointOn/kondi-chat/releases/download/v0.1.0/kondi-chat-0.1.0-darwin-arm64.tar.gz"
      sha256 "TODO_FILL_AFTER_RELEASE"
    else
      url "https://github.com/thisPointOn/kondi-chat/releases/download/v0.1.0/kondi-chat-0.1.0-darwin-x64.tar.gz"
      sha256 "TODO_FILL_AFTER_RELEASE"
    end
  end

  on_linux do
    url "https://github.com/thisPointOn/kondi-chat/releases/download/v0.1.0/kondi-chat-0.1.0-linux-x64.tar.gz"
    sha256 "TODO_FILL_AFTER_RELEASE"
  end

  depends_on "node"

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/kondi-chat"
  end

  test do
    assert_match "kondi-chat", shell_output("#{bin}/kondi-chat --version")
  end
end
