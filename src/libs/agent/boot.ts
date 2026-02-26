/**
 * Lifecycle - Boot 启动阶段
 * @author aokihu <aokihu@gmail.com>
 * @license BSD
 * @version 0.0.1
 * @description 上下文提示词在启动的时候会干扰到boot agent,让他也产生了<<<context>>>内容
 *              因此单独使用另一份提示词context_disable_output_context.md, 并且在提示词中设置了开关 `contextMode`
 *              通过设置`contextMode`为 disabled 避免 boot agent输出<<<context>>>内容
 *              在组装正式提示词的时候,使用 context.md 作为正式的上下文提示词.
 *              目前在deepseek上测试是稳定运行的,需要对其他的模型也进行测试
 */

/* 加载AI SDK */
import { generateText, type LanguageModel } from "ai";

/* 加载提示词文本 */
import BootstrapPrompt from "../../prompts/bootstrap.md" with { type: "text" };
import ContextRulesDisabledPrompt from "../../prompts/context_disable_output_context.md" with { type: "text" };
import ContextRulesEnablePrompt from "../../prompts/context.md" with { type: "text" };
import TodoToolUsagePrompt from "../../prompts/todo_tool_usage.md" with { type: "text" };
import ToolUsageEfficiencyPrompt from "../../prompts/tool_usage_efficiency.md" with { type: "text" };

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
        // 1.1 根据enableOptimization替换bootstrap提示词中的变量{EO_VALUE}
        const bootstrapPrompt = BootstrapPrompt.replace(
            "{EO_VALUE}",
            enableOptimization ? "true" : "false",
        );

        // 1.2.1 关闭上下文生成
        const contextRulesPrompt_disabled_context =
            ContextRulesDisabledPrompt.replace("{MODE}", "disabled");

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
            prompt: [
                "<<<CORE>>>",
                contextRulesPrompt_disabled_context,
                "<<<USER>>>",
                userPrompt,
                extendContent,
            ].join("\n"),
        });

        // console.log(result.text);
        // console.log("Total token:", result.totalUsage);

        return {
            systemPrompt: [
                ContextRulesEnablePrompt,
                TodoToolUsagePrompt,
                ToolUsageEfficiencyPrompt,
                result.text,
            ].join(
                "\n",
            ),
            totalUsage: result.totalUsage,
        };
    };
