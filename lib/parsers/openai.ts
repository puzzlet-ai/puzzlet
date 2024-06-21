import { JSONObject, JSONValue } from "../../common";
import {
  ExecuteResult,
  FunctionData,
  ModelMetadata,
  Output,
  OutputDataWithValue,
  OutputDataWithToolCallsValue,
  Prompt,
  PromptInput,
} from "../../types";
import { AIConfigRuntime } from "../config";
import { ParameterizedModelParser } from "../parameterizedModelParser";
import OpenAI, { ClientOptions } from "openai";
import { omit, union, isEqual } from "../utils";
import { InferenceOptions } from "../modelParser";
import { CallbackEvent } from "../callback";

type CompletionCreateParams = OpenAI.CompletionCreateParams;
type CompletionCreateParamsNonStreaming =
  OpenAI.CompletionCreateParamsNonStreaming;
type CompletionCreateParamsStreaming = OpenAI.CompletionCreateParamsStreaming;
type ChatCompletionMessageParam = OpenAI.Chat.ChatCompletionMessageParam;
type ChatCompletionCreateParams = OpenAI.Chat.ChatCompletionCreateParams;
type ChatCompletionCreateParamsNonStreaming =
  OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
type ChatCompletionCreateParamsStreaming =
  OpenAI.Chat.ChatCompletionCreateParamsStreaming;
type ChatCompletionMessage = OpenAI.Chat.ChatCompletionMessage;
type ChatCompletionChunk = OpenAI.Chat.ChatCompletionChunk;

export class OpenAIModelParser extends ParameterizedModelParser<CompletionCreateParams> {
  private openai: OpenAI | null = null;
  private openaiOptions: ClientOptions | undefined;

  public constructor(options?: ClientOptions) {
    super();
    this.openaiOptions = options;
  }

  public serialize(
    promptName: string,
    // TODO (rossdanlm): Generalize this openai serializer to work with multi-modal inputs, not just text completion
    data: CompletionCreateParams,
    aiConfig: AIConfigRuntime,
    params?: JSONObject
  ): Prompt[] {
    // Serialize prompt input
    let input: PromptInput;
    if (typeof data.prompt === "string") {
      input = data.prompt;
    } else {
      input = {
        data: data.prompt,
      };
    }

    // Serialize model metadata
    let modelMetadata: ModelMetadata | string;
    const promptModelMetadata: JSONObject = { ...data };
    // Remove the prompt from the model data since that is not part of the model settings
    delete promptModelMetadata.prompt;

    // Check if AIConfig already has the model settings in its metadata
    const modelName = data.model ?? this.id;
    const globalModelMetadata = aiConfig.metadata.models?.[modelName];

    if (globalModelMetadata != null) {
      // Check if the model settings from the input data are the same as the global model settings

      // Compute the difference between the global model settings and the model settings from the input data
      // If there is a difference, then we need to add the different model settings as overrides on the prompt's metadata
      const keys = union(
        Object.keys(globalModelMetadata),
        Object.keys(promptModelMetadata)
      );
      const overrides = keys.reduce(
        (result: JSONObject, key) => {
          if (!isEqual(globalModelMetadata[key], promptModelMetadata[key])) {
            result[key] = promptModelMetadata[key];
          }
          return result;
        },
        {}
      );

      if (Object.keys(overrides).length > 0) {
        modelMetadata = {
          name: modelName,
          settings: overrides,
        };
      } else {
        modelMetadata = modelName;
      }
    } else {
      modelMetadata = {
        name: modelName,
        settings: promptModelMetadata,
      };
    }

    const prompt: Prompt = {
      name: promptName,
      input,
      metadata: {
        model: modelMetadata,
        parameters: params ?? {},
      },
    };

    return [prompt];
  }

  public deserialize(
    prompt: Prompt,
    aiConfig: AIConfigRuntime,
    params?: JSONObject
  ): CompletionCreateParams {
    // Build the completion params
    const modelMetadata = this.getModelSettings(prompt, aiConfig);
    const completionParams: CompletionCreateParams = refineCompletionParams(
      modelMetadata ?? {}
    );

    // Resolve the prompt template with the given parameters, and update the completion params
    let resolvedPrompt: string | JSONValue;
    if (typeof prompt.input === "string") {
      resolvedPrompt = this.resolvePromptTemplate(
        prompt.input,
        prompt,
        aiConfig,
        params
      );
    } else if (typeof prompt.input?.data === "string") {
      resolvedPrompt = this.resolvePromptTemplate(
        prompt.input.data,
        prompt,
        aiConfig,
        params
      );
    } else {
      resolvedPrompt = prompt.input?.data ?? null;
    }

    completionParams.prompt = resolvedPrompt as
      | string
      | Array<string>
      | Array<number>
      | Array<Array<number>>
      | null;

    return completionParams;
  }

  public async run(
    prompt: Prompt,
    aiConfig: AIConfigRuntime,
    options?: InferenceOptions,
    params?: JSONObject | undefined
  ): Promise<Output[]> {
    if (!this.openai) {
      this.openai = new OpenAI({
        apiKey: this.apiKey,
        ...(this.openaiOptions || {}),
      });
    }

    const completionParams = this.deserialize(prompt, aiConfig, params);
    const stream = options?.stream ?? completionParams.stream ?? true;

    if (!stream) {
      // If we aren't streaming, then we can just run the prompt as a simple completion
      const response = await this.openai.completions.create(
        completionParams as CompletionCreateParamsNonStreaming,
        {
          stream,
        }
      );

      // Save response as Output(s) in the Prompt
      const outputs: ExecuteResult[] = [];
      for (const choice of response.choices) {
        const output: ExecuteResult = {
          output_type: "execute_result",
          // CompletionChoice does not support function calls
          data: choice.text,
          execution_count: choice.index,
          metadata: {
            finish_reason: choice.finish_reason,
            logprobs: choice.logprobs,
            raw_response: response,
          },
        };
        outputs.push(output);
      }

      prompt.outputs = outputs;
      return outputs;
    } else {
      // For streaming, then we can just run the prompt as a simple completion
      const responseStream = await this.openai.completions.create(
        completionParams as CompletionCreateParamsStreaming,
        {
          stream,
        }
      );

      // These maps are keyed by the choice index
      let outputs: Map<number, ExecuteResult> = new Map<
        number,
        ExecuteResult
      >();
      let completions: Map<number, string> = new Map<number, string>();
      for await (const chunk of responseStream) {
        for (let i = 0; i < chunk.choices.length; i++) {
          const choice = chunk.choices[i]!;

          const completionText = completions.get(choice.index);
          const accumulatedText = (completionText ?? "") + choice.text;
          completions.set(choice.index, accumulatedText);

          // Send the stream callback for each choice
          options?.callbacks?.streamCallback(
            /*data*/ choice.text,
            /*accumulatedData*/ accumulatedText,
            /*index*/ choice.index
          );

          const chunkWithoutChoices = omit(chunk, "choices");
          const output: ExecuteResult = {
            output_type: "execute_result",
            data: accumulatedText,
            execution_count: choice.index,
            metadata: {
              finish_reason: choice.finish_reason,
              logprobs: choice.logprobs,
              ...chunkWithoutChoices,
            },
          };

          outputs.set(choice.index, output);
        }
      }

      // TODO: saqadri - determine if we want to append the new outputs to the previous ones. For now we overwrite them.
      prompt.outputs = Array.from(outputs.values());
      return prompt.outputs;
    }
  }

  public getOutputText(
    aiConfig: AIConfigRuntime,
    output?: Output,
    prompt?: Prompt
  ): string {
    if (output == null && prompt != null) {
      output = aiConfig.getLatestOutput(prompt);
    }

    if (output == null) {
      return "";
    }

    if (output.output_type === "execute_result") {
      if (typeof output.data === "string") {
        return output.data;
      }

      if (output.data?.hasOwnProperty("value")) {
        const outputData = output.data as OutputDataWithValue;
        if (typeof outputData.value === "string") {
          return outputData.value;
        }
        // If we get here that means it must be of kind tool_calls
        return JSON.stringify(outputData.value);
      }

      // Doing this to be backwards-compatible with old output format
      // where we used to save the ChatCompletionMessageParam in output.data
      if (
        output.data?.hasOwnProperty("content") &&
        output.data?.hasOwnProperty("role")
      ) {
        const message = output.data as ChatCompletionMessageParam;
        if (message.content != null) {
          return message.content;
        } else if (message.function_call) {
          return JSON.stringify(message.function_call);
        }
      }
    }
    return "";
  }
}

export class OpenAIChatModelParser extends ParameterizedModelParser<ChatCompletionCreateParams> {
  protected openai: OpenAI | null = null;
  protected openaiOptions: ClientOptions | undefined;

  public constructor(options?: ClientOptions) {
    super();
    this.openaiOptions = options;
  }

  public getPromptTemplate(prompt: Prompt, aiConfig: AIConfigRuntime): string {
    if (typeof prompt.input === "string") {
      return prompt.input;
    } else if (typeof prompt.input?.data === "string") {
      return prompt.input?.data;
    } else {
      const message = prompt.input as ChatCompletionMessageParam;
      return message.content ?? "";
    }
  }

  public serialize(
    promptName: string,
    data: ChatCompletionCreateParams,
    aiConfig: AIConfigRuntime,
    params?: JSONObject
  ): Prompt[] {
    const startEvent = {
      name: "on_serialize_start",
      data: {
        promptName,
        data,
        params,
      },
    } as CallbackEvent;
    aiConfig.callbackManager.runCallbacks(startEvent);

    // Chat completion comes as an array of messages. We can serialize each message as a Prompt.

    // Get the system prompt from the messages
    const systemPrompt = data.messages.find(
      (message) => message.role === "system"
    );

    // Serialize model metadata
    let modelMetadata: ModelMetadata | string;
    const promptModelMetadata: JSONObject = omit(data, "messages");
    // Add the system prompt as part of the model settings
    promptModelMetadata.system_prompt = systemPrompt;

    // Check if AIConfig already has the model settings in its metadata
    const modelName = data.model ?? this.id;
    const globalModelMetadata = aiConfig.metadata.models?.[modelName];

    if (globalModelMetadata != null) {
      // Check if the model settings from the input data are the same as the global model settings

      // Compute the difference between the global model settings and the model settings from the input data
      // If there is a difference, then we need to add the different model settings as overrides on the prompt's metadata
      const keys = union(
        Object.keys(globalModelMetadata),
        Object.keys(promptModelMetadata)
      );
      const overrides = keys.reduce(
        (result: JSONObject, key) => {
          if (!isEqual(globalModelMetadata[key], promptModelMetadata[key])) {
            result[key] = promptModelMetadata[key];
          }
          return result;
        },
        {}
      );

      if (Object.keys(overrides).length > 0) {
        modelMetadata = {
          name: modelName,
          settings: overrides,
        };
      } else {
        modelMetadata = modelName;
      }
    } else {
      modelMetadata = {
        name: modelName,
        settings: promptModelMetadata,
      };
    }

    let prompts: Prompt[] = [];
    let i = 0;
    while (i < data.messages.length) {
      const message = data.messages[i]!;
      if (message.role === "user" || message.role == "function") {
        // Serialize user message as prompt, and save the assistant response as an output
        let assistantResponse: ChatCompletionMessageParam | null = null;
        if (i + 1 < data.messages.length) {
          const nextMessage = data.messages[i + 1]!;
          if (nextMessage.role === "assistant") {
            assistantResponse = nextMessage;
          }
        }

        const input: PromptInput =
          message.role === "user" ? message.content ?? "" : { ...message };
        let outputs: Output[] | undefined = undefined;
        if (assistantResponse != null) {
          const assistantOutputData: OutputDataWithValue | string | undefined =
            buildOutputData(assistantResponse);
          if (assistantOutputData != null) {
            outputs = [
              {
                output_type: "execute_result",
                data: assistantOutputData,
                metadata: {
                  raw_response: assistantResponse,
                  ...omit(assistantResponse, "content", "function_call"),
                },
              },
            ];
          }
        }
        const prompt: Prompt = {
          name: `${promptName}_${prompts.length + 1}`,
          input,
          metadata: {
            model: modelMetadata,
            parameters: params ?? {},
            remember_chat_context: true,
          },
          outputs,
        };

        prompts.push(prompt);
      }

      i++;
    }

    // Rename the last prompt to the requested prompt name
    prompts[prompts.length - 1]!.name = promptName;

    const endEvent = {
      name: "on_serialize_end",
      file: __filename,
      data: {
        result: prompts,
      },
    };
    aiConfig.callbackManager.runCallbacks(endEvent);
    return prompts;
  }

  public deserialize(
    prompt: Prompt,
    aiConfig: AIConfigRuntime,
    params?: JSONObject
  ): ChatCompletionCreateParams {
    const startEvent = {
      name: "on_deserialize_start",
      data: {
        prompt,
        params,
      },
    } as CallbackEvent;
    aiConfig.callbackManager.runCallbacks(startEvent);
    // Build the completion params
    const modelMetadata = this.getModelSettings(prompt, aiConfig) ?? {};
    const completionParams: ChatCompletionCreateParams =
      refineChatCompletionParams(modelMetadata);

    if (completionParams.messages == null) {
      // In the case that messages weren't saved as part of the model settings, we will build messages from the other prompts in the AIConfig
      let messages: ChatCompletionMessageParam[] = [];

      // Add system prompt
      if (modelMetadata.system_prompt != null) {
        const systemPrompt: ChatCompletionMessageParam =
          typeof modelMetadata.system_prompt === "string"
            ? { content: modelMetadata.system_prompt, role: "system" }
            : (modelMetadata.system_prompt as ChatCompletionMessageParam);

        // Resolve the system prompt template with the given parameters
        systemPrompt.content = this.resolvePromptTemplate(
          systemPrompt.content ?? "",
          prompt,
          aiConfig,
          params
        );

        messages.push(systemPrompt);
      }

      if (prompt?.metadata?.remember_chat_context !== false) {
        // Loop through the prompts in the AIConfig and add the user messages to the messages array

        for (let i = 0; i < aiConfig.prompts.length; i++) {
          const currentPrompt = aiConfig.prompts[i]!;
          this.addPromptAsMessage(currentPrompt, aiConfig, messages, params);

          if (currentPrompt.name === prompt.name) {
            // If this is the current prompt, then we have reached the end of the chat history
            break;
          }
        }
      } else {
        this.addPromptAsMessage(prompt, aiConfig, messages, params);
      }

      // Update the completion params with the resolved messages
      completionParams.messages = messages;
    } else {
      // If messages are already specified in the model settings, then just resolve each message with the given parameters and append the latest message
      for (let i = 0; i < completionParams.messages.length; i++) {
        completionParams.messages[i]!.content = this.resolvePromptTemplate(
          completionParams.messages[i]!.content ?? "",
          prompt,
          aiConfig,
          params
        );
      }

      // Add the latest message to the messages array
      // Resolve the prompt with the given parameters, and add it to the messages array
      this.addPromptAsMessage(
        prompt,
        aiConfig,
        completionParams.messages,
        params
      );
    }
    const endEvent = {
      name: "on_deserialize_end",
      data: {
        result: completionParams,
      },
    } as CallbackEvent;
    aiConfig.callbackManager.runCallbacks(endEvent);
    return completionParams;
  }

  public async run(
    prompt: Prompt,
    aiConfig: AIConfigRuntime,
    options?: InferenceOptions,
    params?: JSONObject | undefined
  ): Promise<Output[]> {
    const startEvent = {
      name: "on_run_start",
      data: {
        prompt,
        options,
        params,
      },
    } as CallbackEvent;

    await aiConfig.callbackManager.runCallbacks(startEvent);

    if (!this.openai) {
      this.openai = new OpenAI({
        apiKey: this.apiKey,
        ...(this.openaiOptions || {}),
      });
    }

    const completionParams = this.deserialize(prompt, aiConfig, params);

    const stream = options?.stream ?? completionParams.stream ?? true;

    if (!stream) {
      // If we aren't streaming, then we can just run the prompt as a simple completion
      completionParams.stream = false;
      const response = await this.openai.chat.completions.create(
        completionParams as ChatCompletionCreateParamsNonStreaming
      );

      // Save response as Output(s) in the Prompt
      const outputs: ExecuteResult[] = [];
      const responseWithoutChoices = omit(response, "choices");
      for (const choice of response.choices) {
        const outputData: OutputDataWithValue | string | undefined =
          buildOutputData(choice.message);
        if (outputData == undefined) {
          continue;
        }

        const output: ExecuteResult = {
          output_type: "execute_result",
          data: outputData,
          execution_count: choice.index,
          metadata: {
            finish_reason: choice.finish_reason,
            ...responseWithoutChoices,
            raw_response: choice.message,
            ...omit(choice.message, "content", "function_call"),
          },
        };
        outputs.push(output);
      }

      // TODO: saqadri - determine if we want to append the new outputs to the previous ones. For now we overwrite them.
      prompt.outputs = outputs;
      const endEvent = {
        name: "on_run_end",
        data: {
          result: outputs,
        },
      } as CallbackEvent;
      await aiConfig.callbackManager.runCallbacks(endEvent);
      return outputs;
    } else {
      // For streaming, then we can just run the prompt as a simple completion
      completionParams.stream = true;
      const responseStream = await this.openai.chat.completions.create(
        completionParams as ChatCompletionCreateParamsStreaming
      );

      let outputs = new Map<number, ExecuteResult>();
      let messages: Map<number, ChatCompletionMessage> | null = null;
      for await (const chunk of responseStream) {
        messages = multiChoiceMessageReducer(messages, chunk);

        for (let i = 0; i < chunk.choices.length; i++) {
          const choice = chunk.choices[i]!;
          const message = messages.get(choice.index);

          // Send the stream callback for each choice
          options?.callbacks?.streamCallback(
            /*data*/ {
              ...choice.delta,
            },
            /*accumulatedData*/ message,
            /*index*/ choice.index
          );
          if (message == null) {
            continue;
          }

          const outputData: OutputDataWithValue | string | undefined =
            buildOutputData(message);
          if (outputData == null) {
            continue;
          }

          const output: ExecuteResult = {
            output_type: "execute_result",
            data: outputData,
            execution_count: choice.index,
            metadata: {
              finish_reason: choice.finish_reason,
              raw_response: message,
            },
          };
          outputs.set(choice.index, output);
        }
      }

      // TODO: saqadri - determine if we want to append the new outputs to the previous ones. For now we overwrite them.
      prompt.outputs = Array.from(outputs.values());
      const endEvent = {
        name: "on_run_end",
        data: {
          result: prompt.outputs,
        },
      } as CallbackEvent;
      await aiConfig.callbackManager.runCallbacks(endEvent);
      return prompt.outputs;
    }
  }

  public getOutputText(
    aiConfig: AIConfigRuntime,
    output?: Output,
    prompt?: Prompt
  ): string {
    if (output == null && prompt != null) {
      output = aiConfig.getLatestOutput(prompt);
    }

    if (output == null) {
      return "";
    }

    if (output.output_type === "execute_result") {
      if (typeof output.data === "string") {
        return output.data;
      }

      if (output.data?.hasOwnProperty("value")) {
        const outputData = output.data as OutputDataWithValue;
        if (typeof outputData.value === "string") {
          return outputData.value;
        }
        return JSON.stringify(outputData.value); // function_call
      }

      // Doing this to be backwards-compatible with old output format
      // where we used to save the ChatCompletionMessageParam in output.data
      if (
        output.data?.hasOwnProperty("content") &&
        output.data?.hasOwnProperty("role")
      ) {
        const message = output.data as ChatCompletionMessageParam;
        if (message.content != null) {
          return message.content;
        } else if (message.function_call) {
          return JSON.stringify(message.function_call);
        }
      }
    }
    return "";
  }

  private addPromptAsMessage(
    prompt: Prompt,
    aiConfig: AIConfigRuntime,
    messages: ChatCompletionMessageParam[],
    params?: JSONObject
  ) {
    // Resolve the prompt with the given parameters, and add it to the messages array
    const promptTemplate = this.getPromptTemplate(prompt, aiConfig);

    const resolvedPrompt = this.resolvePromptTemplate(
      promptTemplate,
      prompt,
      aiConfig,
      params
    );

    if (typeof prompt.input === "string") {
      messages.push({
        content: resolvedPrompt,
        role: "user",
      });
    } else {
      messages.push({
        content: resolvedPrompt,
        role: prompt.input?.role ?? "user",
        function_call: prompt.input?.function_call,
        name: prompt.input?.name,
      });
    }

    const output = aiConfig.getLatestOutput(prompt);
    if (output != null) {
      if (output.output_type === "execute_result") {
        if (
          output.metadata?.role ??
          output.metadata?.raw_response?.role === "assistant"
        ) {
          output as ExecuteResult;
          let content: string | null = null;
          let functionCall: FunctionData | undefined;

          if (typeof output.data === "string") {
            content = output.data;
          } else if (output.data?.hasOwnProperty("value")) {
            const outputData = output.data as OutputDataWithValue;
            if (typeof outputData.value === "string") {
              content = outputData.value;
            } else if (outputData.kind === "tool_calls") {
              outputData as OutputDataWithToolCallsValue;
              // Typescript schema does not support array of function calls yet,
              // but Python does so doing this for forward compatibility
              functionCall =
                outputData.value[outputData.value.length - 1]!.function;
            }
          }

          const name: string | undefined | null =
            output.metadata?.name ?? output.metadata?.raw_response?.name;
          messages.push({
            content,
            role: "assistant",
            // We should update this to use ChatCompletionAssistantMessageParam
            // object with field `tool_calls. See comment for details:
            // https://github.com/lastmile-ai/aiconfig/pull/610#discussion_r1437174736
            ...(functionCall != undefined && { function_call: functionCall }),
            ...(name != null && { name }),
          });
        }

        // Doing this to be backwards-compatible with old output format
        // where we used to save the ChatCompletionMessageParam in output.data
        else if (
          output.data?.hasOwnProperty("content") &&
          output.data?.hasOwnProperty("role")
        ) {
          const outputMessage =
            output.data as unknown as ChatCompletionMessageParam;
          if (outputMessage.role === "assistant") {
            messages.push(outputMessage);
          }
        }
      }
    }

    return messages;
  }
}

//#region Utils

/**
 * Convert JSON object of completion params loaded from AIConfig to CompletionCreateParams type
 */
export function refineCompletionParams(
  params: JSONObject
): CompletionCreateParams {
  return {
    model: params.model as string,
    prompt: params.prompt as
      | string
      | Array<string>
      | Array<number>
      | Array<Array<number>>
      | null,
    temperature:
      params.temperature != null ? (params.temperature as number) : undefined,
    top_p: params.top_p != null ? (params.top_p as number) : undefined,
    n: params.n != null ? (params.n as number) : undefined,
    stream: params.stream != null ? (params.stream as boolean) : undefined,
    stop: params.stop as string | null | Array<string>,
    max_tokens: params.max_tokens as number,
    presence_penalty:
      params.presence_penalty != null
        ? (params.presence_penalty as number)
        : undefined,
    frequency_penalty:
      params.frequency_penalty != null
        ? (params.frequency_penalty as number)
        : undefined,
    logit_bias:
      params.logit_bias != null
        ? (params.logit_bias as Record<string, number>)
        : undefined,
    user: params.user as string,
  };
}

/**
 * Convert JSON object of chat completion params loaded from AIConfig to CompletionCreateParams type
 */
export function refineChatCompletionParams(
  params: JSONObject
): ChatCompletionCreateParams {
  return {
    model: params.model as string,
    messages: params.messages as unknown as ChatCompletionMessageParam[],
    functions: params.functions,
    function_call:
      params.function_call != null
        ? (params.function_call as "none" | "auto")
        : undefined,
    temperature:
      params.temperature != null ? (params.temperature as number) : undefined,
    top_p: params.top_p != null ? (params.top_p as number) : undefined,
    n: params.n != null ? (params.n as number) : undefined,
    stream: params.stream != null ? (params.stream as boolean) : undefined,
    stop: params.stop as string | null | Array<string>,
    max_tokens: params.max_tokens as number,
    presence_penalty:
      params.presence_penalty != null
        ? (params.presence_penalty as number)
        : undefined,
    frequency_penalty:
      params.frequency_penalty != null
        ? (params.frequency_penalty as number)
        : undefined,
    logit_bias:
      params.logit_bias != null
        ? (params.logit_bias as Record<string, number>)
        : undefined,
    user: params.user as string,
  };
}

const reduce = (acc: any, delta: any) => {
  acc = { ...acc };
  for (const [key, value] of Object.entries(delta)) {
    if (acc[key] === undefined || acc[key] === null) {
      acc[key] = value;
    } else if (typeof acc[key] === "string" && typeof value === "string") {
      (acc[key] as string) += value;
    } else if (typeof acc[key] === "object" && !Array.isArray(acc[key])) {
      acc[key] = reduce(acc[key], value);
    }
  }
  return acc;
};

function multiChoiceMessageReducer(
  messages: Map<number, ChatCompletionMessage> | null,
  chunk: ChatCompletionChunk
): Map<number, ChatCompletionMessage> {
  if (messages == null) {
    messages = new Map<number, ChatCompletionMessage>();
  } else if (messages.size !== chunk.choices.length) {
    throw new Error(
      "Invalid number of previous choices -- it should match the incoming number of choices"
    );
  }

  for (let i = 0; i < chunk.choices.length; i++) {
    const choice = chunk.choices[i]!;
    const previousMessage = messages.get(choice.index);
    const updatedMessage = reduce(
      previousMessage ?? [],
      choice.delta
    ) as ChatCompletionMessage;
    messages.set(choice.index, updatedMessage);
  }

  return messages;
}

function buildOutputData(
  message: ChatCompletionMessageParam | null
): OutputDataWithValue | string | undefined {
  let outputData: OutputDataWithValue | string | undefined = undefined;
  if (message != null) {
    if (message.content != null) {
      // return a string
      outputData = message.content;
    } else if (message.function_call != null) {
      // return a function call
      outputData = {
        kind: "tool_calls",
        value: [
          {
            type: "function",
            function: message.function_call,
          },
        ],
      };
    }
  }
  return outputData;
}
