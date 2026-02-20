import { readTool } from "./read";
import { webfetchTool } from "./webfetch";
import { writeTool } from "./write";

export default (context: any) => ({
  read: readTool(context),
  write: writeTool(context),
  webfetch: webfetchTool(context),
});
