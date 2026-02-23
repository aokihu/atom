import {
  canCopyFrom,
  canCopyTo,
  canListDir,
  canMoveFrom,
  canMoveTo,
  canReadFile,
  canReadTree,
  canRipgrep,
  canUseGit,
  canVisitUrl,
  canWriteFile,
} from "../permissions";
import type { ToolExecutionContext } from "../types";

const getToolsPermissions = (context: ToolExecutionContext) => context.permissions?.tools;

export class PermissionPolicy {
  constructor(private readonly context: ToolExecutionContext) {}

  canReadFile(filepath: string) {
    return canReadFile(filepath, getToolsPermissions(this.context));
  }

  canListDir(dirpath: string) {
    return canListDir(dirpath, getToolsPermissions(this.context));
  }

  canReadTree(dirpath: string) {
    return canReadTree(dirpath, getToolsPermissions(this.context));
  }

  canRipgrep(dirpath: string) {
    return canRipgrep(dirpath, getToolsPermissions(this.context));
  }

  canWriteFile(filepath: string) {
    return canWriteFile(filepath, getToolsPermissions(this.context));
  }

  canCopyFrom(filepath: string) {
    return canCopyFrom(filepath, getToolsPermissions(this.context));
  }

  canCopyTo(filepath: string) {
    return canCopyTo(filepath, getToolsPermissions(this.context));
  }

  canMoveFrom(filepath: string) {
    return canMoveFrom(filepath, getToolsPermissions(this.context));
  }

  canMoveTo(filepath: string) {
    return canMoveTo(filepath, getToolsPermissions(this.context));
  }

  canUseGit(dirpath: string) {
    return canUseGit(dirpath, getToolsPermissions(this.context));
  }

  canVisitUrl(url: string) {
    return canVisitUrl(url, getToolsPermissions(this.context));
  }
}

export const createPermissionPolicy = (context: ToolExecutionContext) =>
  new PermissionPolicy(context);
