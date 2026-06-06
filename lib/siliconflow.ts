const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4-Pro";
const DEFAULT_TIMEOUT_MS = 360000;

export type SiliconFlowMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type SiliconFlowResponseFormat = {
  type: "json_schema";
  json_schema: {
    name: string;
    schema: Record<string, unknown>;
  };
};

type ChatCompletionOptions = {
  messages: SiliconFlowMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: SiliconFlowResponseFormat;
};

type ChatCompletionChoice = {
  message?: {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
  };
};

type ChatCompletionResponse = {
  choices?: ChatCompletionChoice[];
  error?: {
    message?: string;
  };
};

function getBaseUrl() {
  return process.env.SILICONFLOW_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

function getApiKey() {
  return process.env.SILICONFLOW_API_KEY?.trim() || "";
}

export function getSiliconFlowModel() {
  return process.env.SILICONFLOW_MODEL?.trim() || DEFAULT_MODEL;
}

export function isSiliconFlowConfigured() {
  return Boolean(getApiKey());
}

export async function createSiliconFlowChatCompletion(options: ChatCompletionOptions) {
  const apiKey = getApiKey();

  if (!apiKey) {
    throw new Error("SILICONFLOW_API_KEY is not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${getBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: getSiliconFlowModel(),
        messages: options.messages,
        temperature: options.temperature ?? 0.1,
        max_tokens: options.maxTokens ?? 2000,
        response_format: options.responseFormat,
      }),
      signal: controller.signal,
    });

    const data = (await response.json()) as ChatCompletionResponse;

    if (!response.ok) {
      throw new Error(data.error?.message || "SiliconFlow request failed");
    }

    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) {
      throw new Error("SiliconFlow returned empty content");
    }

    return content;
  } finally {
    clearTimeout(timeout);
  }
}
