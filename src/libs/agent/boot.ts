/**
 * Lifecycle - Boot 启动阶段
 * @author aokihu <aokihu@gmail.com>
 * @license BSD
 * @version 0.0.1
 */

/* 加载AI SDK */
import { generateText, type LanguageModel } from "ai";

/* 加载提示词文本 */
import BootstrapPrompt from "../../prompts/bootstrap.md" with { type: "text" };
import ContextRulesPrompt from "../../prompts/context.md" with { type: "text" };

type LifecycleBootParams = {
  userPromptFilePath: string;
  enableOptimization?: boolean;
  extendContent?: string;
};

/**
 * 启动阶段
 * @param userPromptFilePath 用户提示词的文件路径,绝对地址
 * @param enableOptimization 是否开启对用户提示词的优化,默认是`true`
 * @param extendContent 扩展内容,可以是任何的文字信息,效果与用户提示词一样
 * @returns 返回整合了核心提示词和用户提示词的最终提示词
 */
export const bootstrap =
  (llmModel: LanguageModel) =>
  async ({
    userPromptFilePath,
    enableOptimization = true,
    extendContent,
  }: LifecycleBootParams) => {
    // 1. 根据enableOptimization替换bootstrap提示词中的变量{EO_VALUE}
    const bootstrapPrompt = BootstrapPrompt.replace(
      "{EO_VALUE}",
      enableOptimization ? "true" : "false",
    );

    // 2. 加载用户设定的提示词,文件名只能是AGENT.md
    const userPromptFile = Bun.file(userPromptFilePath);
    if (!(await userPromptFile.exists())) {
      throw new Error("AGENT.md is not exists");
    }

    const userPrompt = await userPromptFile.text();

    const result = await generateText({
      model: llmModel,
      system: bootstrapPrompt,
      temperature: 0,
      prompt: ["[===以下是用户提示词===]", userPrompt, extendContent].join(
        "\n",
      ),
    });

    console.log(result.text);
    console.log("Total token:", result.totalUsage);

    return {
      systemPrompt: [ContextRulesPrompt, result.text].join("\n"),
      totalUsage: result.totalUsage,
    };
  };
