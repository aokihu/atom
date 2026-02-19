import { readTool } from "./read";
import { webfetchTool } from "./webfetch";

export default (context: any) => ({
  read: readTool(context),
  webfetch: webfetchTool(context),
});
