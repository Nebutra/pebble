import { beforeEach, describe, expect, it, vi } from "vitest";

const { homeDirMock, invokeMock } = vi.hoisted(() => ({
  homeDirMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: homeDirMock,
}));

import type { PreloadApi } from "../../../src/preload/api-types";
import { createPebbleGitTextGenerationApi } from "./tauri-source-control-text-generation";

function createGitApi(): PreloadApi["git"] {
  return createPebbleGitTextGenerationApi({} as PreloadApi["git"]);
}

const customParams = {
  agentId: "custom" as const,
  model: "custom",
  customAgentCommand: "printf {prompt}",
};

beforeEach(() => {
  vi.clearAllMocks();
  homeDirMock.mockResolvedValue("/Users/test");
});

describe("createPebbleGitTextGenerationApi", () => {
  it("generates a commit message through the native Tauri text-generation host", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "source_control_text_generation_commit_context") {
        return {
          branch: "feature/tauri-ai",
          stagedSummary: "M\tREADME.md",
          stagedPatch:
            "diff --git a/README.md b/README.md\n+Tauri text generation",
        };
      }
      if (command === "source_control_text_generation_execute_plan") {
        return {
          stdout: "Add Tauri source control AI generation\n",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          canceled: false,
          spawnError: null,
        };
      }
      throw new Error(`unexpected command ${command}`);
    });

    await expect(
      createGitApi().generateCommitMessage({
        worktreePath: "/repo/worktree",
        sourceControlAiResolvedParams: customParams,
      }),
    ).resolves.toEqual({
      success: true,
      message: "Add Tauri source control AI generation",
      agentLabel: "printf",
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "source_control_text_generation_commit_context",
      {
        input: { cwd: "/repo/worktree" },
      },
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "source_control_text_generation_execute_plan",
      expect.objectContaining({
        input: expect.objectContaining({
          cwd: "/repo/worktree",
          binary: "printf",
          laneKey: "commit-message:local:/repo/worktree",
        }),
      }),
    );
  });

  it("generates pull request fields from native branch context", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "source_control_text_generation_pull_request_context") {
        return {
          branch: "feature/pr",
          base: "main",
          branchChangedByPreparation: false,
          currentTitle: "",
          currentBody: "",
          currentDraft: false,
          commitSummary: "- Add PR generation",
          changeSummary: "M\tREADME.md",
          patch: "diff --git a/README.md b/README.md\n+PR generation",
        };
      }
      if (command === "source_control_text_generation_execute_plan") {
        return {
          stdout: JSON.stringify({
            title: "Add Tauri PR generation",
            body: "Summary\n- Adds native generation.",
            draft: true,
          }),
          stderr: "",
          exitCode: 0,
          timedOut: false,
          canceled: false,
          spawnError: null,
        };
      }
      throw new Error(`unexpected command ${command}`);
    });

    await expect(
      createGitApi().generatePullRequestFields({
        worktreePath: "/repo/worktree",
        base: "main",
        title: "",
        body: "",
        draft: false,
        sourceControlAiResolvedParams: customParams,
      }),
    ).resolves.toMatchObject({
      success: true,
      fields: {
        base: "main",
        title: "Add Tauri PR generation",
        body: "Summary\n- Adds native generation.",
        draft: true,
      },
      agentLabel: "printf",
      branchChangedByPreparation: false,
    });
  });
});
