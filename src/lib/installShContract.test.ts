import { describe, expect, it } from "vitest";
import installer from "../../install.sh?raw";
import readme from "../../README.md?raw";

describe("macOS/Linux curl installer contract", () => {
  it("is the documented macOS/Linux quick-start path", () => {
    expect(readme).toContain("curl -fsSL https://raw.githubusercontent.com/xobash/xo-mesa/main/install.sh | bash");
  });

  it("clones or fast-forwards an existing Mesa checkout before launch", () => {
    expect(installer).toContain('repo_url="https://github.com/xobash/xo-mesa.git"');
    expect(installer).toContain('[[ "$(basename "${current_dir}")" == "xo-mesa" && -d "${current_dir}/.git" ]]');
    expect(installer).toContain('git -C "${install_dir}" pull --ff-only');
    expect(installer).toContain('git clone "${repo_url}" "${install_dir}"');
    expect(installer).toContain("exec bash ./run.sh");
  });

  it("can bootstrap git before the repository exists", () => {
    expect(installer).toContain("ensure_git()");
    expect(installer).toContain("xcode-select --install");
    expect(installer).toContain("sudo apt install -y git");
    expect(installer).toContain("sudo pacman -S --needed --noconfirm git");
    expect(installer).toContain("sudo dnf install -y git");
  });
});
