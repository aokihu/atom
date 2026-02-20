import { lsTool } from "./ls";
import { readTool } from "./read";
import { ripgrepTool } from "./ripgrep";
import { treeTool } from "./tree";
import { webfetchTool } from "./webfetch";
import { writeTool } from "./write";

export default (context: any) => ({
  ls: lsTool(context),
  read: readTool(context),
  tree: treeTool(context),
  ripgrep: ripgrepTool(context),
  write: writeTool(context),
  webfetch: webfetchTool(context),
});
