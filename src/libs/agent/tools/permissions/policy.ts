import {
  canListDir,
  canReadFile,
  canReadTree,
  canRipgrep,
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

  canVisitUrl(url: string) {
    return canVisitUrl(url, getToolsPermissions(this.context));
  }
}

export const createPermissionPolicy = (context: ToolExecutionContext) =>
  new PermissionPolicy(context);

