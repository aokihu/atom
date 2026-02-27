import {
  canCopyFrom,
  canCopyTo,
  canListDir,
  canUseMemory,
  canMoveFrom,
  canMoveTo,
  canReadFile,
  canReadTree,
  canRipgrep,
  canUseBackground,
  canUseTodo,
  canUseBash,
  canUseGit,
  canVisitUrl,
  canWriteFile,
  getWorkspaceAgentRipgrepExcludes,
  hasSensitiveWorkspacePathReference,
  shouldHideWorkspaceAgentEntry,
} from "../permissions";
import type { ToolExecutionContext } from "../types";

const getToolsPermissions = (context: ToolExecutionContext) =>
  context.permissions?.permissions;

export class PermissionPolicy {
  constructor(private readonly context: ToolExecutionContext) {}

  canReadFile(filepath: string) {
    return canReadFile(
      filepath,
      getToolsPermissions(this.context),
      this.context.workspace,
    );
  }

  canListDir(dirpath: string) {
    return canListDir(dirpath, getToolsPermissions(this.context), this.context.workspace);
  }

  canReadTree(dirpath: string) {
    return canReadTree(dirpath, getToolsPermissions(this.context), this.context.workspace);
  }

  canRipgrep(dirpath: string) {
    return canRipgrep(dirpath, getToolsPermissions(this.context), this.context.workspace);
  }

  shouldHideDirEntry(parentDir: string, entryName: string) {
    return shouldHideWorkspaceAgentEntry(parentDir, entryName, this.context.workspace);
  }

  getRipgrepExcludeGlobs(searchDir: string) {
    return getWorkspaceAgentRipgrepExcludes(searchDir, this.context.workspace);
  }

  canWriteFile(filepath: string) {
    return canWriteFile(
      filepath,
      getToolsPermissions(this.context),
      this.context.workspace,
    );
  }

  canUseTodo(filepath: string) {
    return canUseTodo(filepath, getToolsPermissions(this.context));
  }

  canUseMemory(target: string) {
    return canUseMemory(target, getToolsPermissions(this.context));
  }

  canCopyFrom(filepath: string) {
    return canCopyFrom(
      filepath,
      getToolsPermissions(this.context),
      this.context.workspace,
    );
  }

  canCopyTo(filepath: string) {
    return canCopyTo(
      filepath,
      getToolsPermissions(this.context),
      this.context.workspace,
    );
  }

  canMoveFrom(filepath: string) {
    return canMoveFrom(
      filepath,
      getToolsPermissions(this.context),
      this.context.workspace,
    );
  }

  canMoveTo(filepath: string) {
    return canMoveTo(
      filepath,
      getToolsPermissions(this.context),
      this.context.workspace,
    );
  }

  canUseGit(dirpath: string) {
    return canUseGit(
      dirpath,
      getToolsPermissions(this.context),
      this.context.workspace,
    );
  }

  canUseBash(dirpath: string) {
    return canUseBash(
      dirpath,
      getToolsPermissions(this.context),
      this.context.workspace,
    );
  }

  canUseBackground(dirpath: string) {
    return canUseBackground(
      dirpath,
      getToolsPermissions(this.context),
      this.context.workspace,
    );
  }

  canVisitUrl(url: string) {
    return canVisitUrl(url, getToolsPermissions(this.context));
  }

  hasSensitivePathReference(input: string, cwd?: string) {
    return hasSensitiveWorkspacePathReference(input, {
      workspace: this.context.workspace,
      cwd,
    });
  }
}

export const createPermissionPolicy = (context: ToolExecutionContext) =>
  new PermissionPolicy(context);
