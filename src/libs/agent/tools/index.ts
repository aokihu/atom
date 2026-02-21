import { lsTool } from "./ls";
import { readEmailTool } from "./read_email";
import { readTool } from "./read";
import { ripgrepTool } from "./ripgrep";
import { sendEmailTool } from "./send_email";
import { treeTool } from "./tree";
import { webfetchTool } from "./webfetch";
import { writeTool } from "./write";

export default (context: any) => ({
  ls: lsTool(context),
  read: readTool(context),
  read_email: readEmailTool(context),
  tree: treeTool(context),
  ripgrep: ripgrepTool(context),
  write: writeTool(context),
  webfetch: webfetchTool(context),
  send_email: sendEmailTool(context),
});
