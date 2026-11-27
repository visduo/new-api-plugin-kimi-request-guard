export const meta = {
  apiVersion: 1,
  key: "visduo_kimi-request-guard",
  name: { en: "Kimi Request Guard", zh: "Kimi 请求校验" },
  description: {
    en: "Enforces the Kimi series request contract: parameter limits, media formats, tool rules and reasoning effort",
    zh: "按 Kimi 系列模型的请求规范校验参数限制、媒体格式、工具规则与推理强度",
  },
  version: "1.1.4",
  author: { name: "多栈科技" },
  website: "https://www.echostack.net/",
};

// 只处理已知的 Kimi 系列模型，其余模型原样放行。
// K3 系列走 reasoning_effort；K2.6 与 K2.7 Code 仍使用 thinking。
const K3_PREFIX = "kimi-k3";
const K26_PATTERN = /^kimi-k2\.6($|-)/;
const K27_PATTERN = /^kimi-k2\.7($|-)/;

// Kimi K3 只接受这三个思考强度。
const EFFORTS = ["low", "high", "max"];

// K3 支持的图片格式（SVG 不在内，官方明确拒绝）。
const IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/heic",
  "image/heif",
];

// K3 支持的视频格式。
const VIDEO_MIMES = [
  "video/mp4",
  "video/mpeg",
  "video/mov",
  "video/avi",
  "video/x-flv",
  "video/mpg",
  "video/webm",
  "video/wmv",
  "video/3gpp",
];

// Claude Messages 协议只声明了这四种图片类型。
const CLAUDE_IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// 官方工具名规则：字母或下划线开头，最长 128。
const TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$/;

// 宿主把内联媒体换成 "[media:N]"，真实类型在 req.media 里。
const MEDIA_REF = /^\[media:(\d+)\]$/;

// 网关单次请求最多接受 512 条 json.patch 操作，留一条给 reasoning_effort。
const MAX_PATCH_OPS = 511;

// 需要改写的消息达到这个数量时，合并成一次 replace /messages。
const MIN_REPLACE_MESSAGES = 8;

// K3 单次输出上限。
const MAX_OUTPUT_TOKENS = 1048576;

// K2.6 与 K2.7 Code 的上下文窗口是 256K。
const MAX_K2_OUTPUT_TOKENS = 262144;

// Chat Completions 里 K3 完全不接受的参数。
const CHAT_UNSUPPORTED = [
  "reasoning",
  "seed",
  "logit_bias",
  "user",
  "parallel_tool_calls",
  "functions",
  "function_call",
  "metadata",
  "store",
  "service_tier",
  "verbosity",
  "modalities",
  "audio",
  "max_output_tokens",
  "top_k",
  "min_p",
  "repetition_penalty",
  "typical_p",
  "min_tokens",
];

// Chat 固定采样参数：只能等于官方值。
const CHAT_FIXED = [
  ["temperature", 1],
  ["top_p", 0.95],
  ["n", 1],
  ["presence_penalty", 0],
  ["frequency_penalty", 0],
];

// K2 系列不支持 K3 的推理参数与动态工具。
const K2_UNSUPPORTED = ["reasoning_effort"];

// 判断模型属于哪一代 Kimi。
function kimiFamily(model) {
  if (model.indexOf(K3_PREFIX) === 0) return "k3";
  if (K26_PATTERN.test(model)) return "k26";
  if (K27_PATTERN.test(model)) return "k27";
  return "";
}

// 每一代模型的最大输出。
function maxOutputTokens(family) {
  return family === "k3" ? MAX_OUTPUT_TOKENS : MAX_K2_OUTPUT_TOKENS;
}

// 判断是否普通对象（排除 null 与数组）。
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 字段存在且不是 null 才算“传了”。
function present(value) {
  return value !== undefined && value !== null;
}

// 判断对象自身是否有该字段（null 也算传了）。
function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// 按 UTF-8 字节数计算长度，官方限制用的是字节。
function utf8Length(text) {
  return encodeURIComponent(text).replace(/%[0-9A-F]{2}/g, "x").length;
}

// 统一的拒绝结果，code 只能用小写字母、数字、点、下划线、横线。
function reject(code, message) {
  return { action: "reject", code: code, message: message };
}

// 判断字符串是否形如 data:<mime>;base64,... 且 mime 在允许列表内。
function isDataUrl(url, mimes) {
  if (url.indexOf("data:") !== 0) return false;
  const end = url.indexOf(";");
  const mime = (end < 0 ? url.slice(5) : url.slice(5, end)).toLowerCase();
  return mimes.indexOf(mime) >= 0;
}

// 从 req.media 里找出内联媒体的真实 MIME。
function mediaMime(media, url) {
  const match = MEDIA_REF.exec(url);
  if (!match || !Array.isArray(media)) return "";
  for (const item of media) {
    if (isObject(item) && item.index === Number(match[1]) && typeof item.mimeType === "string") {
      return item.mimeType.toLowerCase();
    }
  }
  return "";
}

// 校验一段媒体地址：允许 ms:// 文件引用、允许允许列表内的 data URL。
// 公网 http(s) 一律拒绝，K3 只吃 base64 或 ms://<file_id>。
function checkMediaUrl(url, kind, media) {
  if (typeof url !== "string" || url === "") {
    return kind === "image" ? "image_url needs a url." : "video_url needs a url.";
  }
  // ms:// 是 Moonshot 自己的文件协议，直接放行。
  if (url.indexOf("ms://") === 0) return null;
  // 宿主托管的内联媒体：用 req.media 的真实类型判断。
  const inlineMime = mediaMime(media, url);
  if (MEDIA_REF.test(url) && !inlineMime) return null;
  const allowed = kind === "image" ? IMAGE_MIMES : VIDEO_MIMES;
  if (inlineMime) {
    if (kind === "image" && inlineMime.indexOf("image/svg") === 0) {
      return "SVG is not supported as image input.";
    }
    if (allowed.indexOf(inlineMime) >= 0) return null;
    return "Unsupported " + kind + " type " + inlineMime + ".";
  }
  if (url.toLowerCase().indexOf("data:image/svg") === 0) {
    return "SVG is not supported as image input.";
  }
  if (isDataUrl(url, allowed)) return null;
  if (kind === "image") {
    return "URL-formatted images are not supported; pass base64-encoded image content or an ms:// file ID.";
  }
  return "URL-formatted videos are not supported; pass base64-encoded video content or an ms:// file ID.";
}

// ===================== JSON Schema 递归检查 =====================

// 解析 # 开头的 JSON Pointer，返回目标节点；解析失败返回 undefined。
function resolvePointer(root, ref) {
  if (typeof ref !== "string" || ref.indexOf("#") !== 0) return undefined;
  const pointer = ref.slice(1);
  if (pointer === "") return root;
  if (pointer.charAt(0) !== "/") return undefined;
  let node = root;
  const parts = pointer.slice(1).split("/");
  for (const raw of parts) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
      node = node[Number(key)];
    } else if (isObject(node)) {
      if (!hasOwn(node, key)) return undefined;
      node = node[key];
    } else {
      return undefined;
    }
    if (node === undefined) return undefined;
  }
  return node;
}

// 展开 $ref 链时允许叠加的纯注解关键字（与官方校验器一致）。
const REF_ANNOTATIONS = ["description", "title"];

// 沿 $ref 链展开，直到遇到带约束的节点或形成环。
// 官方校验器在检查递归前会先展开纯 $ref 链，并保留外层的 description/title。
function expandRefChain(node, root) {
  const seen = new Set();
  const annotations = {};
  let current = node;
  while (isObject(current) && typeof current.$ref === "string") {
    for (const key of REF_ANNOTATIONS) {
      if (hasOwn(current, key)) annotations[key] = current[key];
    }
    if (seen.has(current.$ref)) break;
    seen.add(current.$ref);
    const target = resolvePointer(root, current.$ref);
    if (!isObject(target)) break;
    current = target;
    let constrained = false;
    for (const key of Object.keys(target)) {
      if (key !== "$ref" && REF_ANNOTATIONS.indexOf(key) < 0) {
        constrained = true;
        break;
      }
    }
    if (constrained) break;
  }
  if (!isObject(current)) return current;
  const merged = {};
  for (const key of Object.keys(current)) merged[key] = current[key];
  for (const key of Object.keys(annotations)) merged[key] = annotations[key];
  return merged;
}

// 判断一个（已展开的）Schema 能否产生有限实例。
// 规则与官方校验器 walle 的 CheckRefTermination 一致：
// 非对象/数组类型直接终止；对象要求所有 required 属性都能终止；
// 数组只有在 minItems > 0 时才要求 items 能终止；anyOf 只要有一个分支能终止即可。
function terminates(node, root, visited, state) {
  if (!isObject(node)) return node === true;
  state.steps++;
  // 超出预算时不再拦截，避免把超大但合法的 Schema 误判成递归。
  if (state.steps > state.budget) {
    state.aborted = true;
    return true;
  }
  let checkType = "";
  if (hasOwn(node, "type")) {
    const type = node.type;
    if (typeof type === "string") {
      if (type !== "object" && type !== "array") return true;
      checkType = type;
    } else if (Array.isArray(type)) {
      for (const item of type) {
        if (typeof item !== "string") continue;
        if (item !== "object" && item !== "array") return true;
        checkType = item;
      }
    }
  }
  if (checkType === "array") {
    // 没有正数 minItems 时，空数组就是合法实例。
    if (typeof node.minItems !== "number" || node.minItems <= 0) return true;
    if (!present(node.items)) return true;
    if (isObject(node.items) && Object.keys(node.items).length === 0) return true;
    if (isObject(node.items) && terminates(node.items, root, visited, state)) return true;
  }
  if (checkType === "object") {
    if (!present(node.required)) return true;
    if (Array.isArray(node.required) && node.required.length === 0) return true;
    const properties = isObject(node.properties) ? node.properties : null;
    if (!properties || Object.keys(properties).length === 0) return true;
    // 每个 required 属性都必须能终止，任何一个无解都会让整个对象无解。
    for (const name of Object.keys(properties)) {
      if (!Array.isArray(node.required) || node.required.indexOf(name) < 0) continue;
      const property = properties[name];
      if (!isObject(property)) continue;
      if (!terminates(property, root, new Set(visited), state)) return false;
    }
    return true;
  }
  if (Array.isArray(node.anyOf)) {
    if (node.anyOf.length === 0) return true;
    // 分支之间互不影响，每个分支用自己的 visited 集合。
    for (const branch of node.anyOf) {
      if (!isObject(branch)) continue;
      if (terminates(branch, root, new Set(visited), state)) return true;
    }
  }
  if (typeof node.$ref === "string") {
    if (visited.has(node.$ref)) return false;
    visited.add(node.$ref);
    const target = resolvePointer(root, node.$ref);
    // 无法解析的引用交给其它校验；这里不额外拦截。
    if (!isObject(target)) return true;
    return terminates(target, root, visited, state);
  }
  if (Object.keys(node).length === 0) return true;
  return false;
}

// 遍历 Schema 里的每个 $ref 使用点，返回第一个无法终止的路径（形如 properties.n）。
// 与官方一致：跳过 $defs（其中的定义由使用点展开检查）；additionalProperties
// 与 required 为空数组的 properties 不要求终止；anyOf 的每个分支都要单独检查。
function findRecursionPath(root) {
  const state = { steps: 0, budget: 100000, aborted: false };
  const joinPath = (base, segment) => (base === "" ? segment : base + "." + segment);
  const walk = (node, path, needCheck, topLevel) => {
    if (!isObject(node)) return "";
    if (typeof node.$ref === "string" && needCheck) {
      const expanded = expandRefChain(node, root);
      if (isObject(expanded) && !terminates(expanded, root, new Set(), state)) {
        return topLevel ? "root" : path;
      }
      if (state.aborted) return "";
    }
    for (const key of Object.keys(node)) {
      if (key === "$defs") continue;
      const value = node[key];
      if (isObject(value)) {
        let childCheck = needCheck;
        if (key === "additionalProperties") childCheck = false;
        if (key === "properties" && Array.isArray(node.required) && node.required.length === 0) {
          childCheck = false;
        }
        const problem = walk(value, joinPath(path, key), childCheck, false);
        if (problem) return problem;
        if (state.aborted) return "";
        continue;
      }
      if (key === "anyOf" && Array.isArray(value)) {
        for (const branch of value) {
          const problem = walk(branch, joinPath(path, "anyOf"), needCheck, false);
          if (problem) return problem;
          if (state.aborted) return "";
        }
      }
    }
    return "";
  };
  const problem = walk(root, "", true, true);
  if (state.aborted) return "";
  return problem;
}

// MFJS 只接受这 7 个 type 取值；大小写不符、int/bool/dict 等写法都会被上游拒绝。
const MFJS_TYPES = ["null", "boolean", "object", "array", "number", "integer", "string"];

// 校验单个节点的 type 取值，返回问题描述或空串。
// 官方把 type 不是字符串/数组、数组为空、取值不在枚举里都算 schema 不合法。
function typeProblem(node) {
  if (!hasOwn(node, "type")) return "";
  const type = node.type;
  if (typeof type === "string") {
    return MFJS_TYPES.indexOf(type) < 0 ? "invalid type" : "";
  }
  if (!Array.isArray(type)) return "type must be a string or an array of strings";
  if (type.length === 0) return "type array cannot be empty";
  for (const item of type) {
    if (typeof item !== "string" || MFJS_TYPES.indexOf(item) < 0) return "invalid type";
  }
  return "";
}

// 沿 Schema 树找出第一个非法的 type，返回 {path, reason} 或 null。
// 遍历范围与官方 walle 的 strict 级别一致：$defs、properties、items、
// additionalProperties 和 anyOf。oneOf / allOf / not / if / prefixItems /
// definitions 等上游不遍历，这里也不展开，避免把上游接受的 schema 误判。
function findInvalidType(node, path) {
  if (!isObject(node)) return null;
  const here = path === "" ? "root" : path;
  const reason = typeProblem(node);
  if (reason) return { path: here, reason: reason };
  const defs = node.$defs;
  if (isObject(defs)) {
    for (const name of Object.keys(defs)) {
      const problem = findInvalidType(defs[name], "$defs." + name);
      if (problem) return problem;
    }
  }
  const properties = node.properties;
  if (isObject(properties)) {
    for (const name of Object.keys(properties)) {
      // 官方要求每个属性都给一个 schema 对象，true/false 简写会被拒绝。
      if (!isObject(properties[name])) {
        return { path: "properties", reason: "property schema for '" + name + "' must be an object" };
      }
      const problem = findInvalidType(properties[name], "properties." + name);
      if (problem) return problem;
    }
  }
  const items = node.items;
  if (isObject(items)) {
    const problem = findInvalidType(items, "items");
    if (problem) return problem;
  }
  const additional = node.additionalProperties;
  if (isObject(additional)) {
    const problem = findInvalidType(additional, "additionalProperties");
    if (problem) return problem;
  }
  const anyOf = node.anyOf;
  if (Array.isArray(anyOf)) {
    for (const branch of anyOf) {
      const problem = findInvalidType(branch, "anyOf");
      if (problem) return problem;
    }
  }
  return null;
}

// 收集文档里所有 $ref 指向的 definitions 名字；官方只把被引用的定义并入 $defs。
function collectDefinitionRefs(value, names) {
  if (Array.isArray(value)) {
    for (const item of value) collectDefinitionRefs(item, names);
    return;
  }
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (key === "$ref" && typeof item === "string" && item.indexOf("#/definitions/") === 0) {
      names.add(item.slice("#/definitions/".length));
      continue;
    }
    collectDefinitionRefs(item, names);
  }
}

// 按 MFJS 校验 type；与官方 walle 的 strict 级别一致。
function checkMfjsType(schema, label) {
  let problem = findInvalidType(schema, "");
  if (!problem && isObject(schema.definitions)) {
    const names = new Set();
    collectDefinitionRefs(schema, names);
    for (const name of Object.keys(schema.definitions)) {
      if (!names.has(name)) continue;
      problem = findInvalidType(schema.definitions[name], "definitions." + name);
      if (problem) break;
    }
  }
  if (!problem) return null;
  if (problem.reason !== "invalid type") {
    return label + ": At path '" + problem.path + "': " + problem.reason + ".";
  }
  return (
    label +
    ": At path '" +
    problem.path +
    "': invalid type, type must be one of " +
    MFJS_TYPES.join(", ") +
    "."
  );
}

function checkSchema(schema, label) {
  if (!present(schema)) return null;
  if (!isObject(schema) && schema !== true) return label + " must be an object.";
  if (!isObject(schema)) return null;
  const invalidType = checkMfjsType(schema, label);
  if (invalidType) return invalidType;
  const path = findRecursionPath(schema);
  if (!path) return null;
  return label + ": At path '" + path + "': detected infinite recursion without termination condition";
}
// ===================== Chat Completions（openai） =====================

// 校验 Chat 的固定采样参数与输出上限。
// K2.6 在关闭思考时官方把 temperature 固定为 0.6，其余情况为 1。
function checkChatSampling(body, family) {
  const thinkingOff =
    family === "k26" && isObject(body.thinking) && body.thinking.type === "disabled";
  for (const pair of CHAT_FIXED) {
    const name = pair[0];
    let expected = pair[1];
    if (name === "temperature" && thinkingOff) expected = 0.6;
    if (!present(body[name])) continue;
    if (typeof body[name] !== "number" || body[name] !== expected) {
      return name + " is fixed at " + expected + " and cannot be modified.";
    }
  }
  if (present(body.max_completion_tokens)) {
    const value = body.max_completion_tokens;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return "max_completion_tokens must be an integer.";
    }
    if (value > maxOutputTokens(family)) {
      return "max_completion_tokens must not exceed " + maxOutputTokens(family) + ".";
    }
    if (value < 1) return "max_completion_tokens must be greater than 0.";
  }
  if (present(body.max_tokens)) {
    const value = body.max_tokens;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return "max_tokens must be an integer.";
    }
    if (value > maxOutputTokens(family)) {
      return "max_tokens must not exceed " + maxOutputTokens(family) + ".";
    }
    if (value < 1) return "max_tokens must be greater than 0.";
  }
  if (present(body.top_logprobs)) {
    const value = body.top_logprobs;
    if (typeof value !== "number" || !Number.isInteger(value)) return "top_logprobs must be an integer.";
    if (value > 20 || value < 0) return "top_logprobs must be between 0 and 20.";
    if (body.logprobs !== true) return "logprobs must be true when top_logprobs is used.";
  }
  if (present(body.stop)) {
    const stop = body.stop;
    if (typeof stop === "string") {
      if (utf8Length(stop) > 32) return "stop strings must not exceed 32 bytes.";
    } else if (Array.isArray(stop)) {
      if (stop.length > 5) return "stop accepts at most 5 strings.";
      for (const item of stop) {
        if (typeof item !== "string") return "stop must be a string or an array of strings.";
        if (utf8Length(item) > 32) return "stop strings must not exceed 32 bytes.";
      }
    } else {
      return "stop must be a string or an array of strings.";
    }
  }
  if (present(body.prediction)) {
    if (!isObject(body.prediction) || body.prediction.type !== "content") {
      return 'prediction.type must be "content".';
    }
  }
  if (present(body.prompt_cache_options)) {
    const options = body.prompt_cache_options;
    if (!isObject(options)) return "prompt_cache_options must be an object.";
    if (present(options.mode) && options.mode !== "implicit") {
      return 'prompt_cache_options.mode only supports "implicit".';
    }
    if (present(options.ttl) && options.ttl !== "5m" && options.ttl !== "1h") {
      return 'prompt_cache_options.ttl must be "5m" or "1h".';
    }
  }
  if (isObject(body.stream_options) && present(body.stream_options.include_obfuscation)) {
    return "stream_options.include_obfuscation is not supported.";
  }
  return null;
}

// 校验 Chat 的 response_format。
function checkChatResponseFormat(body) {
  const format = body.response_format;
  if (!present(format)) return null;
  if (!isObject(format)) return "response_format must be an object.";
  if (format.type !== "text" && format.type !== "json_object" && format.type !== "json_schema") {
    return 'response_format.type must be one of "text", "json_object", or "json_schema".';
  }
  if (format.type !== "json_schema") return null;
  const schema = format.json_schema;
  if (!isObject(schema)) {
    return 'response_format.json_schema is required when response_format.type is "json_schema".';
  }
  if (typeof schema.name !== "string" || schema.name === "") return "json_schema needs a name.";
  if (!isObject(schema.schema)) return "json_schema needs a schema object.";
  const schemaProblem = checkSchema(schema.schema, "json_schema.schema");
  if (schemaProblem) return schemaProblem;
  if (present(schema.strict) && typeof schema.strict !== "boolean") {
    return "json_schema.strict must be a boolean.";
  }
  return null;
}

// 校验 Chat 的 tool_choice；K3 常开思考，指定具体函数会冲突。
// K2 系列只支持 auto / none，传 required 会报错。
function checkChatToolChoice(body, family) {
  const choice = body.tool_choice;
  if (!present(choice)) return null;
  if (typeof choice === "string") {
    if (choice === "auto" || choice === "none") return null;
    if (choice === "required" && family === "k3") return null;
    if (choice === "required") return 'tool_choice "required" is not supported by this model.';
    return 'tool_choice must be one of "auto", "none", or "required", or a function object.';
  }
  if (!isObject(choice)) {
    return 'tool_choice must be one of "auto", "none", or "required", or a function object.';
  }
  if (choice.type !== "function") {
    return 'tool_choice.type must be "function" when tool_choice is an object.';
  }
  if (!isObject(choice.function) || typeof choice.function.name !== "string" || choice.function.name === "") {
    return "tool_choice needs function.name.";
  }
  return "tool_choice 'specified' is incompatible with thinking enabled";
}

// 校验单个 Chat 工具定义。
function checkChatTool(tool) {
  if (!isObject(tool)) return "Dynamic tools must not contain null.";
  if (tool.type !== "function") return "Tool type must be function.";
  if (!isObject(tool.function)) return "Tool must declare function.";
  const name = tool.function.name;
  if (typeof name !== "string" || name === "") return "Tool must declare function.name.";
  if (!TOOL_NAME.test(name)) return "Tool name must match ^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$.";
  return checkSchema(tool.function.parameters, "Tool parameters");
}

// 校验 Chat 的全局工具与动态工具：位置、字段、重名、required 至少一个工具。
// 动态工具（system 消息里的 tools）只有 K3 支持。
function checkChatTools(body, family) {
  const names = new Set();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const groups = [];
  if (present(body.tools)) groups.push(body.tools);
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isObject(message) || !present(message.tools)) continue;
    if (family !== "k3") {
      return "Dynamic tools are only supported by the Kimi K3 series.";
    }
    // 动态工具只允许出现在 system 消息里。
    if (message.role !== "system") {
      return "messages[" + i + "]: dynamic tools are only allowed in system messages.";
    }
    // 带工具声明的 system 消息不能同时带正文，由 checkChatContent 统一校验。
    groups.push(message.tools);
  }
  let total = 0;
  for (const tools of groups) {
    if (!Array.isArray(tools)) return "Tools must be an array.";
    for (const tool of tools) {
      const problem = checkChatTool(tool);
      if (problem) return problem;
      total++;
      // 工具名必须全局唯一（含动态工具）。
      if (names.has(tool.function.name)) {
        return "Tool name " + tool.function.name + " is declared more than once.";
      }
      names.add(tool.function.name);
    }
  }
  if (body.tool_choice === "required" && total === 0) {
    return 'tool_choice "required" needs at least one tool.';
  }
  return null;
}

// 判断动态工具消息的 content 是否为空（空串或纯空文本块都算空）。
function isEmptyContent(content) {
  if (!present(content)) return true;
  if (typeof content === "string") return content.trim() === "";
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!isObject(part) || part.type !== "text" || typeof part.text !== "string" || part.text.trim() !== "") {
        return false;
      }
    }
    return true;
  }
  return false;
}

// Responses 的 content 是字符串或 content part 数组，空数组与纯空文本都算空。
function isEmptyResponsesContent(content) {
  if (!present(content)) return true;
  if (typeof content === "string") return content.trim() === "";
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return true;
  for (const part of content) {
    if (!isObject(part) || typeof part.text !== "string" || part.text.trim() !== "") return false;
  }
  return true;
}

// 校验 Chat 消息的 content：官方要求 content 不得为空。
// 例外：带动态工具声明的 system 消息本来就要求省略正文；
// 带 tool_calls 的 assistant 消息在官方指南里是 content: ""，需要把 null 与空白块归一成空串。
// 需要改写的消息下标收集到 normalize，由 chatContentOps 统一生成补丁。
function checkChatContent(messages, normalize) {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isObject(message)) return "Messages must be objects.";
    const role = message.role;
    // 动态工具声明的 system 消息必须省略正文，交给 checkChatTools 继续校验。
    if (role === "system" && present(message.tools)) {
      if (!isEmptyContent(message.content)) {
        return "messages[" + i + "] (system): a dynamic tool message must not carry content.";
      }
      continue;
    }
    // 官方指南里工具调用轮的 assistant content 是 ""；null 与空白 text 块会被上游判空。
    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      if (message.content !== "" && isEmptyContent(message.content)) {
        normalize.push(i);
      }
      continue;
    }
    if (isEmptyContent(message.content)) {
      return "messages[" + i + "] (" + String(role) + "): content must not be empty.";
    }
  }
  return null;
}

// 把需要归一的 content 生成补丁。
// 消息较多且没有媒体占位符时合并成一次 replace /messages，把操作数从 N 降到 1；
// 有 "[media:N]" 占位符时不能整段替换（补丁 value 不允许含占位符），退回逐条 add。
// 逐条 add 放不进预算时返回 null，由调用方给出明确的拒绝原因。
function chatContentOps(body, normalize, budget) {
  if (normalize.length === 0) return [];
  const messages = body.messages;
  if (normalize.length >= MIN_REPLACE_MESSAGES && JSON.stringify(messages).indexOf("[media:") < 0) {
    const copy = messages.slice();
    for (const i of normalize) {
      const next = Object.assign({}, copy[i]);
      next.content = "";
      copy[i] = next;
    }
    return [{ op: "replace", path: "/messages", value: copy }];
  }
  if (normalize.length > budget) return null;
  const ops = [];
  for (const i of normalize) {
    ops.push({ op: "add", path: "/messages/" + i + "/content", value: "" });
  }
  return ops;
}

// 校验 Chat 历史里的 tool_calls 与 tool 消息是否一一配对。
function checkChatToolHistory(messages) {
  const pending = new Map();
  for (const message of messages) {
    if (!isObject(message)) continue;
    if (message.role === "tool") {
      const id = message.tool_call_id;
      if (typeof id !== "string" || id === "") return "A tool message must carry tool_call_id.";
      const count = pending.get(id) || 0;
      if (count === 0) return "tool_call_id not found: " + id + " matches no tool_call.";
      if (count === 1) pending.delete(id);
      else pending.set(id, count - 1);
      continue;
    }
    if (!present(message.tool_calls)) continue;
    if (!Array.isArray(message.tool_calls)) return "tool_calls must be an array.";
    for (const call of message.tool_calls) {
      if (!isObject(call) || !isObject(call.function)) return "tool_calls need a function object.";
      if (typeof call.function.name !== "string" || call.function.name === "") {
        return "tool_calls function.name is required.";
      }
      if (typeof call.id !== "string" || call.id === "") return "tool_calls need an id.";
      pending.set(call.id, (pending.get(call.id) || 0) + 1);
    }
  }
  if (pending.size > 0) {
    return "tool_call_id not found: each tool_call must be followed by a tool message with the matching tool_call_id.";
  }
  return null;
}

// 校验 Chat 消息里的多模态内容。
function checkChatMedia(messages, media) {
  for (const message of messages) {
    if (!isObject(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isObject(part)) return "Content parts must be objects with a type.";
      if (part.type === "text") continue;
      if (part.type !== "image_url" && part.type !== "video_url") {
        return "Content parts only support text, image_url and video_url.";
      }
      const raw = part.type === "image_url" ? part.image_url : part.video_url;
      const url = typeof raw === "string" ? raw : isObject(raw) ? raw.url : "";
      const problem = checkMediaUrl(url, part.type === "image_url" ? "image" : "video", media);
      if (problem) return problem;
    }
  }
  return null;
}

// 校验 K2 系列的 thinking：K2.6 可关闭思考，K2.7 Code 只能保持开启。
function checkChatThinking(body, family) {
  if (!present(body.thinking)) return null;
  const thinking = body.thinking;
  if (!isObject(thinking)) return "thinking must be an object.";
  if (thinking.type === "enabled") {
    // 合法。
  } else if (thinking.type === "disabled" && family === "k26") {
    // 合法。
  } else if (thinking.type === "disabled") {
    return 'thinking.type "disabled" is not supported by this model.';
  } else {
    return 'thinking.type must be "enabled" or "disabled".';
  }
  if (present(thinking.keep) && thinking.keep !== "all" && thinking.keep !== null) {
    return 'thinking.keep must be "all" or null.';
  }
  return null;
}

// Chat 的思考参数：K3 用 thinking.effort 优先，缺省 max，最后转成 reasoning_effort；
// K2 系列沿用 thinking，不改写。
function planChatReasoning(body, family) {
  if (family !== "k3") {
    if (present(body.reasoning_effort)) {
      return { error: "reasoning_effort is not supported by this model." };
    }
    return { effort: "", rewrite: false };
  }
  const thinking = body.thinking;
  let effort = body.reasoning_effort;
  if (isObject(thinking) && present(thinking.effort)) effort = thinking.effort;
  if (!present(effort)) effort = "max";
  if (typeof effort !== "string" || EFFORTS.indexOf(effort) < 0) {
    return { error: 'reasoning_effort must be one of "low", "high", or "max".' };
  }
  return { effort: effort, rewrite: hasOwn(body, "thinking") || body.reasoning_effort !== effort };
}

// Chat 协议入口：先校验，最后把 thinking 改写成 reasoning_effort。
function checkChat(body, media, family) {
  for (const name of CHAT_UNSUPPORTED) {
    if (present(body[name])) return { problem: name + " is not supported." };
  }
  if (family !== "k3") {
    for (const name of K2_UNSUPPORTED) {
      if (present(body[name])) return { problem: name + " is not supported." };
    }
  }
  const reasoning = planChatReasoning(body, family);
  if (reasoning.error) return { problem: reasoning.error };
  if (family !== "k3") {
    const thinking = checkChatThinking(body, family);
    if (thinking) return { problem: thinking };
  }
  const sampling = checkChatSampling(body, family);
  if (sampling) return { problem: sampling };
  const format = checkChatResponseFormat(body);
  if (format) return { problem: format };
  const choice = checkChatToolChoice(body, family);
  if (choice) return { problem: choice };
  const tools = checkChatTools(body, family);
  if (tools) return { problem: tools };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return { problem: "messages must not be empty." };
  // 空 content 直接拒绝；工具调用轮的空正文会归一成官方要求的 ""。
  const normalize = [];
  const content = checkChatContent(messages, normalize);
  if (content) return { problem: content };
  const history = checkChatToolHistory(messages);
  if (history) return { problem: history };
  const mediaProblem = checkChatMedia(messages, media);
  if (mediaProblem) return { problem: mediaProblem };
  // 与其它协议保持同一返回结构：effort 为最终强度，hasThinking 表示客户端传了 thinking。
  return { effort: reasoning.effort, hasThinking: hasOwn(body, "thinking"), normalize: normalize };
}

// ===================== Responses（openai_responses） =====================

// 校验 Responses 的工具定义：function / custom / namespace / web_search。
function checkResponsesTool(tool, state) {
  if (!isObject(tool)) return "Tools must be objects.";
  if (tool.type === "function") {
    if (typeof tool.name !== "string" || tool.name === "") return "Function tools need a name.";
    if (!TOOL_NAME.test(tool.name)) return "Tool name must match ^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$.";
    const problem = checkSchema(tool.parameters, "Tool parameters");
    if (problem) return problem;
    if (present(tool.strict) && typeof tool.strict !== "boolean") return "Tool strict must be a boolean.";
    return state.add(tool.name);
  }
  if (tool.type === "custom") {
    // 官方只支持 apply_patch，且必须给 lark 语法。
    if (tool.name !== "apply_patch") return "Only the custom tool apply_patch is supported.";
    if (!isObject(tool.format) || tool.format.type !== "grammar" || tool.format.syntax !== "lark") {
      return "apply_patch needs a grammar format with lark syntax.";
    }
    return state.add(tool.name);
  }
  if (tool.type === "namespace") {
    if (typeof tool.name !== "string" || tool.name === "") return "Namespace tools need a name.";
    if (!Array.isArray(tool.tools)) return "Namespace tools need a tools array.";
    for (const inner of tool.tools) {
      const problem = checkResponsesTool(inner, state);
      if (problem) return problem;
    }
    return null;
  }
  if (tool.type === "web_search") {
    // 每个请求最多一个 web_search。
    if (state.webSearch > 0) return "At most one web_search tool is allowed.";
    state.webSearch++;
    if (present(tool.search_context_size) || present(tool.blocked_domains)) {
      return "web_search search_context_size and blocked_domains are not supported.";
    }
    if (isObject(tool.filters) && present(tool.filters.blocked_domains)) {
      return "web_search filters.blocked_domains is not supported.";
    }
    return null;
  }
  return "Unsupported tool type " + String(tool.type) + ".";
}

// 校验 Responses 的 input 项：消息、函数调用、调用结果、附加工具等。
function checkResponsesInput(items, media, state) {
  const pending = new Map();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!isObject(item)) return "Input items must be objects.";
    // type 缺省时按 message 处理。
    const type = present(item.type) ? item.type : "message";
    if (type === "message") {
      if (isEmptyResponsesContent(item.content)) {
        return "input[" + i + "] (" + String(item.role) + "): content must not be empty.";
      }
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!isObject(part)) return "Content parts must be objects.";
          if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
            if (typeof part.text !== "string" || part.text.trim() === "") {
              return "input[" + i + "]: text content must not be empty.";
            }
            continue;
          }
          if (part.type === "input_image" || part.type === "image_url") {
            const url = typeof part.image_url === "string" ? part.image_url : "";
            const problem = checkMediaUrl(url, "image", media);
            if (problem) return problem;
            continue;
          }
          return "Unsupported content part type " + String(part.type) + ".";
        }
      }
      continue;
    }
    if (type === "function_call" || type === "custom_tool_call") {
      if (typeof item.call_id !== "string" || item.call_id === "") return type + " needs a call_id.";
      if (typeof item.name !== "string" || item.name === "") return type + " needs a name.";
      pending.set(item.call_id, (pending.get(item.call_id) || 0) + 1);
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      if (typeof item.call_id !== "string" || item.call_id === "") return type + " needs a call_id.";
      const count = pending.get(item.call_id) || 0;
      if (count === 0) return "call_id not found: " + item.call_id + " matches no tool call.";
      if (count === 1) pending.delete(item.call_id);
      else pending.set(item.call_id, count - 1);
      continue;
    }
    if (type === "additional_tools") {
      // 中途加工具只能挂在 developer 角色上。
      if (item.role !== "developer") return "additional_tools must use the developer role.";
      if (!Array.isArray(item.tools)) return "additional_tools needs a tools array.";
      for (const tool of item.tools) {
        const problem = checkResponsesTool(tool, state);
        if (problem) return problem;
      }
      continue;
    }
    // reasoning / web_search_call 属于历史回放，不额外校验。
    if (type === "reasoning" || type === "web_search_call") continue;
    return "Unsupported input item type " + String(type) + ".";
  }
  if (pending.size > 0) {
    return "call_id not found: each tool call must be followed by its output item.";
  }
  return null;
}

// Responses 协议入口：校验工具、输入、输出上限、reasoning 与文本格式。
// K2 系列在 Responses 接口上使用 Chat 的 thinking，不改写思考参数。
function checkResponses(body, media, family) {
  const state = { names: new Set(), webSearch: 0 };
  state.add = function (name) {
    if (state.names.has(name)) return "Tool name " + name + " is declared more than once.";
    state.names.add(name);
    return null;
  };

  if (present(body.tools)) {
    if (!Array.isArray(body.tools)) return { problem: "Tools must be an array." };
    for (const tool of body.tools) {
      const problem = checkResponsesTool(tool, state);
      if (problem) return { problem: problem };
    }
  }
  // Responses 只支持 tool_choice=auto。
  if (present(body.tool_choice) && body.tool_choice !== "auto") {
    return { problem: 'tool_choice only supports "auto".' };
  }
  if (present(body.max_output_tokens)) {
    const value = body.max_output_tokens;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return { problem: "max_output_tokens must be an integer." };
    }
    if (value > maxOutputTokens(family)) {
      return { problem: "max_output_tokens must not exceed " + maxOutputTokens(family) + "." };
    }
    if (value < 1) return { problem: "max_output_tokens must be greater than 0." };
  }
  const input = body.input;
  if (typeof input !== "string") {
    if (!Array.isArray(input)) return { problem: "input must be a string or an array." };
    const problem = checkResponsesInput(input, media, state);
    if (problem) return { problem: problem };
  }
  // K3 的 reasoning.effort 只接受 low/high/max；K2 系列没有这个字段。
  if (present(body.reasoning)) {
    if (family !== "k3") return { problem: "reasoning is not supported by this model." };
    if (!isObject(body.reasoning)) return { problem: "reasoning must be an object." };
    if (present(body.reasoning.effort) && EFFORTS.indexOf(body.reasoning.effort) < 0) {
      return { problem: 'reasoning.effort must be one of "low", "high", or "max".' };
    }
  }
  // text.format 只支持 json_schema。
  if (present(body.text)) {
    if (!isObject(body.text)) return { problem: "text must be an object." };
    const format = body.text.format;
    if (present(format)) {
      if (!isObject(format) || format.type !== "json_schema") {
        return { problem: 'text.format.type must be "json_schema".' };
      }
      if (!isObject(format.schema)) return { problem: "text.format needs a schema object." };
      const schemaProblem = checkSchema(format.schema, "text.format.schema");
      if (schemaProblem) return { problem: schemaProblem };
      if (present(format.strict) && typeof format.strict !== "boolean") {
        return { problem: "text.format.strict must be a boolean." };
      }
    }
  }
  if (present(body.prompt_cache_options)) {
    const options = body.prompt_cache_options;
    if (!isObject(options)) return { problem: "prompt_cache_options must be an object." };
    if (present(options.mode) && options.mode !== "implicit") {
      return { problem: 'prompt_cache_options.mode only supports "implicit".' };
    }
    if (present(options.ttl) && options.ttl !== "5m" && options.ttl !== "1h") {
      return { problem: 'prompt_cache_options.ttl must be "5m" or "1h".' };
    }
  }

  if (family !== "k3") {
    const thinking = checkChatThinking(body, family);
    if (thinking) return { problem: thinking };
    return { effort: "" };
  }

  // 缺省思考强度时补 max；客户端若用 Chat 的 thinking 写法也一并归一。
  const thinking = body.thinking;
  let effort = isObject(body.reasoning) ? body.reasoning.effort : undefined;
  if (isObject(thinking) && present(thinking.effort)) effort = thinking.effort;
  if (!present(effort)) effort = "max";
  if (EFFORTS.indexOf(effort) < 0) {
    return { problem: 'reasoning.effort must be one of "low", "high", or "max".' };
  }
  return { effort: effort, hasThinking: hasOwn(body, "thinking") };
}

// ===================== Claude Messages（claude） =====================

// 校验 Claude 工具定义：name + input_schema，type 只能是 custom。
function checkClaudeTool(tool, state) {
  if (!isObject(tool)) return "Tools must be objects.";
  if (present(tool.type) && tool.type !== "custom") return 'Tool type must be "custom".';
  if (typeof tool.name !== "string" || tool.name === "") return "Tools need a name.";
  if (!TOOL_NAME.test(tool.name)) return "Tool name must match ^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$.";
  if (!isObject(tool.input_schema)) return "Tools need an input_schema object.";
  if (present(tool.input_schema.type) && tool.input_schema.type !== "object") {
    return 'input_schema.type must be "object".';
  }
  const problem = checkSchema(tool.input_schema, "Tool input_schema");
  if (problem) return problem;
  if (state.names.has(tool.name)) return "Tool name " + tool.name + " is declared more than once.";
  state.names.add(tool.name);
  return null;
}

// 校验 Claude 的图片块：base64 只允许四种类型，url 只允许 ms://。
function checkClaudeImage(source, media) {
  if (!isObject(source)) return "Image blocks need a source object.";
  if (source.type === "base64") {
    if (typeof source.media_type !== "string") return "Base64 images need a media_type.";
    if (CLAUDE_IMAGE_MIMES.indexOf(source.media_type.toLowerCase()) < 0) {
      return "Unsupported image type " + source.media_type + ".";
    }
    if (typeof source.data !== "string" || source.data === "") return "Base64 images need data.";
    return null;
  }
  if (source.type === "url") {
    const url = typeof source.url === "string" ? source.url : "";
    if (url.indexOf("ms://") !== 0) {
      return "URL-formatted images are not supported; pass base64-encoded image content or an ms:// file ID.";
    }
    return null;
  }
  return "Image source type must be base64 or url.";
}

// Messages 的 content 是字符串或内容块数组，空串、空数组和纯空文本块都算空。
function isEmptyClaudeContent(content) {
  if (!present(content)) return true;
  if (typeof content === "string") return content.trim() === "";
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return true;
  for (const block of content) {
    if (!isObject(block)) return false;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim() === "") continue;
    return false;
  }
  return true;
}

// 校验 Claude 消息块，并配对 tool_use 与 tool_result。
function checkClaudeMessages(messages, media) {
  const pending = new Map();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isObject(message)) return "Messages must be objects.";
    if (message.role !== "user" && message.role !== "assistant") {
      return "Message role must be user or assistant.";
    }
    if (isEmptyClaudeContent(message.content)) {
      return "messages[" + i + "] (" + message.role + "): content must not be empty.";
    }
    if (typeof message.content === "string") continue;
    if (!Array.isArray(message.content)) return "Message content must be a string or an array.";
    for (const block of message.content) {
      if (!isObject(block)) return "Content blocks must be objects.";
      if (block.type === "text") {
        if (typeof block.text !== "string" || block.text.trim() === "") {
          return "messages[" + i + "]: text blocks must not be empty.";
        }
        continue;
      }
      if (block.type === "thinking" || block.type === "redacted_thinking") continue;
      if (block.type === "image") {
        const problem = checkClaudeImage(block.source, media);
        if (problem) return problem;
        continue;
      }
      if (block.type === "tool_use") {
        if (typeof block.id !== "string" || block.id === "") return "tool_use needs an id.";
        if (typeof block.name !== "string" || block.name === "") return "tool_use needs a name.";
        pending.set(block.id, (pending.get(block.id) || 0) + 1);
        continue;
      }
      if (block.type === "tool_result") {
        if (typeof block.tool_use_id !== "string" || block.tool_use_id === "") {
          return "tool_result needs a tool_use_id.";
        }
        const count = pending.get(block.tool_use_id) || 0;
        if (count === 0) {
          return "tool_use_id not found: " + block.tool_use_id + " matches no tool_use.";
        }
        if (count === 1) pending.delete(block.tool_use_id);
        else pending.set(block.tool_use_id, count - 1);
        continue;
      }
      return "Unsupported content block type " + String(block.type) + ".";
    }
  }
  if (pending.size > 0) {
    return "tool_use_id not found: each tool_use must be followed by a tool_result.";
  }
  return null;
}

// Claude 协议入口：校验必填项、采样、停止词、工具与 output_config。
// Kimi 的 Messages 接口只开放给 K3 系列，K2 系列在这里不做改写。
function checkClaude(body, media, family) {
  if (!present(body.max_tokens)) return { problem: "max_tokens is required." };
  if (typeof body.max_tokens !== "number" || !Number.isInteger(body.max_tokens) || body.max_tokens < 1) {
    return { problem: "max_tokens must be a positive integer." };
  }
  if (body.max_tokens > maxOutputTokens(family)) {
    return { problem: "max_tokens must not exceed " + maxOutputTokens(family) + "." };
  }
  // Kimi 的 Messages 接口没有 temperature/top_p，K3 也只接受固定值。
  if (present(body.temperature) && body.temperature !== 1) {
    return { problem: "temperature is fixed at 1 and cannot be modified." };
  }
  if (present(body.top_p) && body.top_p !== 0.95) {
    return { problem: "top_p is fixed at 0.95 and cannot be modified." };
  }
  if (present(body.stop_sequences)) {
    const stops = body.stop_sequences;
    if (!Array.isArray(stops)) return { problem: "stop_sequences must be an array." };
    if (stops.length > 5) return { problem: "stop_sequences accepts at most 5 entries." };
    for (const item of stops) {
      if (typeof item !== "string") return { problem: "stop_sequences must contain strings." };
      if (utf8Length(item) > 32) return { problem: "stop_sequences entries must not exceed 32 bytes." };
    }
  }
  if (present(body.system)) {
    if (typeof body.system !== "string" && !Array.isArray(body.system)) {
      return { problem: "system must be a string or an array of text blocks." };
    }
    if (Array.isArray(body.system)) {
      for (const block of body.system) {
        if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") {
          return { problem: "system blocks must be text blocks." };
        }
      }
    }
  }
  if (present(body.metadata)) {
    if (!isObject(body.metadata)) return { problem: "metadata must be an object." };
    if (present(body.metadata.user_id) && typeof body.metadata.user_id !== "string") {
      return { problem: "metadata.user_id must be a string." };
    }
  }
  if (present(body.cache_control)) {
    const cache = body.cache_control;
    if (!isObject(cache) || cache.type !== "ephemeral") {
      return { problem: 'cache_control.type must be "ephemeral".' };
    }
    if (present(cache.ttl) && cache.ttl !== "5m" && cache.ttl !== "1h") {
      return { problem: 'cache_control.ttl must be "5m" or "1h".' };
    }
  }
  const state = { names: new Set() };
  if (present(body.tools)) {
    if (!Array.isArray(body.tools)) return { problem: "Tools must be an array." };
    for (const tool of body.tools) {
      const problem = checkClaudeTool(tool, state);
      if (problem) return { problem: problem };
    }
  }
  if (present(body.tool_choice)) {
    const choice = body.tool_choice;
    if (!isObject(choice) || ["auto", "any", "none"].indexOf(choice.type) < 0) {
      return { problem: 'tool_choice.type must be "auto", "any", or "none".' };
    }
  }
  if (!Array.isArray(body.messages)) return { problem: "messages must be an array." };
  const messages = checkClaudeMessages(body.messages, media);
  if (messages) return { problem: messages };

  // output_config.effort 是官方写法；客户端若传 thinking 则换算成 effort。
  const outputConfig = isObject(body.output_config) ? body.output_config : null;
  if (outputConfig && present(outputConfig.format)) {
    const format = outputConfig.format;
    if (!isObject(format) || format.type !== "json_schema" || !isObject(format.schema)) {
      return { problem: "output_config.format must be a json_schema object with a schema." };
    }
    const schemaProblem = checkSchema(format.schema, "output_config.format.schema");
    if (schemaProblem) return { problem: schemaProblem };
  }
  if (family !== "k3") return { effort: "" };
  const thinking = body.thinking;
  let effort = outputConfig ? outputConfig.effort : undefined;
  if (isObject(thinking) && present(thinking.effort)) effort = thinking.effort;
  if (!present(effort)) effort = "max";
  if (EFFORTS.indexOf(effort) < 0) {
    return { problem: 'output_config.effort must be one of "low", "high", or "max".' };
  }
  return { effort: effort, hasThinking: hasOwn(body, "thinking") };
}

// ===================== Gemini（gemini） =====================

// 校验 Gemini 的 part：文本、内联媒体、文件引用、函数调用与结果。
function checkGeminiParts(parts, media, pending) {
  for (const part of parts) {
    if (!isObject(part)) return "Parts must be objects.";
    if (typeof part.text === "string") continue;
    if (part.thought === true) continue;
    if (isObject(part.inlineData)) {
      const mime = typeof part.inlineData.mimeType === "string" ? part.inlineData.mimeType.toLowerCase() : "";
      if (typeof part.inlineData.data !== "string" || part.inlineData.data === "") {
        return "inlineData needs data.";
      }
      if (mime.indexOf("image/") === 0) {
        if (mime.indexOf("image/svg") === 0) return "SVG is not supported as image input.";
        if (IMAGE_MIMES.indexOf(mime) < 0) return "Unsupported image type " + mime + ".";
        continue;
      }
      if (VIDEO_MIMES.indexOf(mime) >= 0) continue;
      return "Unsupported inlineData type " + mime + ".";
    }
    if (isObject(part.fileData)) {
      const uri = typeof part.fileData.fileUri === "string" ? part.fileData.fileUri : "";
      if (uri.indexOf("ms://") !== 0) {
        return "URL-formatted media is not supported; pass base64 content or an ms:// file ID.";
      }
      continue;
    }
    if (isObject(part.functionCall)) {
      const name = part.functionCall.name;
      if (typeof name !== "string" || name === "") return "functionCall needs a name.";
      pending.set(name, (pending.get(name) || 0) + 1);
      continue;
    }
    if (isObject(part.functionResponse)) {
      const name = part.functionResponse.name;
      if (typeof name !== "string" || name === "") return "functionResponse needs a name.";
      const count = pending.get(name) || 0;
      if (count === 0) return "functionResponse not found: " + name + " matches no functionCall.";
      if (count === 1) pending.delete(name);
      else pending.set(name, count - 1);
      continue;
    }
    return "Unsupported part type.";
  }
  return null;
}

// Gemini 的 parts 为空、或只有空文本时都算没有正文。
function isEmptyGeminiParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return true;
  for (const part of parts) {
    if (!isObject(part)) return false;
    if (typeof part.text === "string") {
      if (part.text.trim() !== "") return false;
      continue;
    }
    return false;
  }
  return true;
}

// Gemini 协议入口：校验 contents、generationConfig、tools 与 toolConfig。
function checkGemini(body, media, family) {
  const config = body.generationConfig;
  if (present(config)) {
    if (!isObject(config)) return { problem: "generationConfig must be an object." };
    if (present(config.temperature) && config.temperature !== 1) {
      return { problem: "temperature is fixed at 1 and cannot be modified." };
    }
    if (present(config.topP) && config.topP !== 0.95) {
      return { problem: "topP is fixed at 0.95 and cannot be modified." };
    }
    if (present(config.candidateCount) && config.candidateCount !== 1) {
      return { problem: "candidateCount is fixed at 1 and cannot be modified." };
    }
    if (present(config.maxOutputTokens)) {
      const value = config.maxOutputTokens;
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return { problem: "maxOutputTokens must be an integer." };
      }
      if (value > maxOutputTokens(family)) {
        return { problem: "maxOutputTokens must not exceed " + maxOutputTokens(family) + "." };
      }
      if (value < 1) return { problem: "maxOutputTokens must be greater than 0." };
    }
    if (present(config.stopSequences)) {
      const stops = config.stopSequences;
      if (!Array.isArray(stops)) return { problem: "stopSequences must be an array." };
      if (stops.length > 5) return { problem: "stopSequences accepts at most 5 entries." };
      for (const item of stops) {
        if (typeof item !== "string") return { problem: "stopSequences must contain strings." };
        if (utf8Length(item) > 32) return { problem: "stopSequences entries must not exceed 32 bytes." };
      }
    }
    if (present(config.thinkingConfig)) {
      const thinking = config.thinkingConfig;
      if (!isObject(thinking)) return { problem: "thinkingConfig must be an object." };
      if (present(thinking.includeThoughts) && typeof thinking.includeThoughts !== "boolean") {
        return { problem: "thinkingConfig.includeThoughts must be a boolean." };
      }
      if (present(thinking.thinkingBudget)) {
        const budget = thinking.thinkingBudget;
        if (typeof budget !== "number" || !Number.isInteger(budget) || budget < 0) {
          return { problem: "thinkingConfig.thinkingBudget must be a non-negative integer." };
        }
      }
    }
  }

  // 工具声明：名字规则与重名检查。
  const names = new Set();
  if (present(body.tools)) {
    if (!Array.isArray(body.tools)) return { problem: "Tools must be an array." };
    for (const tool of body.tools) {
      if (!isObject(tool)) return { problem: "Tools must be objects." };
      if (!present(tool.functionDeclarations)) continue;
      if (!Array.isArray(tool.functionDeclarations)) {
        return { problem: "functionDeclarations must be an array." };
      }
      for (const declaration of tool.functionDeclarations) {
        if (!isObject(declaration)) return { problem: "functionDeclarations must contain objects." };
        const name = declaration.name;
        if (typeof name !== "string" || name === "") return { problem: "Function declarations need a name." };
        if (!TOOL_NAME.test(name)) {
          return { problem: "Tool name must match ^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$." };
        }
        if (names.has(name)) return { problem: "Tool name " + name + " is declared more than once." };
        names.add(name);
        const problem = checkSchema(declaration.parameters, "Function parameters");
        if (problem) return { problem: problem };
      }
    }
  }

  // toolConfig：ANY + allowedFunctionNames 等于指定函数，与常开思考冲突。
  if (present(body.toolConfig)) {
    const config2 = body.toolConfig;
    if (!isObject(config2)) return { problem: "toolConfig must be an object." };
    const calling = config2.functionCallingConfig;
    if (present(calling)) {
      if (!isObject(calling)) return { problem: "functionCallingConfig must be an object." };
      if (present(calling.mode) && ["AUTO", "ANY", "NONE"].indexOf(calling.mode) < 0) {
        return { problem: 'functionCallingConfig.mode must be "AUTO", "ANY", or "NONE".' };
      }
      if (present(calling.allowedFunctionNames)) {
        if (!Array.isArray(calling.allowedFunctionNames) || calling.allowedFunctionNames.length === 0) {
          return { problem: "allowedFunctionNames must be a non-empty array." };
        }
        return { problem: "tool_choice 'specified' is incompatible with thinking enabled" };
      }
    }
  }

  if (present(body.systemInstruction)) {
    const instruction = body.systemInstruction;
    if (!isObject(instruction) || !Array.isArray(instruction.parts)) {
      return { problem: "systemInstruction needs a parts array." };
    }
  }

  if (!Array.isArray(body.contents)) return { problem: "contents must be an array." };
  const pending = new Map();
  for (let i = 0; i < body.contents.length; i++) {
    const content = body.contents[i];
    if (!isObject(content)) return { problem: "contents must contain objects." };
    if (present(content.role) && ["user", "model", "system"].indexOf(content.role) < 0) {
      return { problem: "content.role must be user, model, or system." };
    }
    if (!Array.isArray(content.parts)) return { problem: "content needs a parts array." };
    if (isEmptyGeminiParts(content.parts)) {
      return { problem: "contents[" + i + "] (" + String(content.role) + "): parts must not be empty." };
    }
    const problem = checkGeminiParts(content.parts, media, pending);
    if (problem) return { problem: problem };
  }
  if (pending.size > 0) {
    return { problem: "functionResponse not found: each functionCall must be followed by its functionResponse." };
  }

  // Gemini 没有 thinking.effort，思考强度由 thinkingConfig 决定，这里不改写。
  return { effort: "" };
}

// ===================== 协议分发 =====================

// 按协议名分派；未覆盖的协议直接放行，保证以后新增协议不会被误拦。
function inspect(format, body, media, family) {
  if (format === "openai") {
    // /v1/completions 与 /v1/moderations 共用这个名字，只有 messages 才是 Chat。
    if (!Array.isArray(body.messages)) return null;
    return checkChat(body, media, family);
  }
  if (format === "openai_responses") return checkResponses(body, media, family);
  if (format === "claude") return checkClaude(body, media, family);
  if (format === "gemini") return checkGemini(body, media, family);
  return null;
}

// 把 K3 的思考强度写回各协议自己的字段，并删掉 Kimi 不认的 thinking。
// K2 系列保留自己的 thinking 与 reasoning_effort，不做改写。
function reasoningEffects(format, body, result, family) {
  if (family !== "k3") return [];
  const ops = [];
  if (hasOwn(body, "thinking")) ops.push({ op: "remove", path: "/thinking" });
  if (format === "openai") {
    if (body.reasoning_effort !== result.effort) {
      ops.push({ op: "add", path: "/reasoning_effort", value: result.effort });
    }
    return ops;
  }
  if (format === "openai_responses") {
    // Responses 用 reasoning.effort；已有对象时只改 effort 字段。
    if (isObject(body.reasoning)) {
      if (body.reasoning.effort !== result.effort) {
        ops.push({ op: "add", path: "/reasoning/effort", value: result.effort });
      }
    } else {
      ops.push({ op: "add", path: "/reasoning", value: { effort: result.effort } });
    }
    return ops;
  }
  if (format === "claude") {
    // Claude Messages 用 output_config.effort。
    if (isObject(body.output_config)) {
      if (body.output_config.effort !== result.effort) {
        ops.push({ op: "add", path: "/output_config/effort", value: result.effort });
      }
    } else {
      ops.push({ op: "add", path: "/output_config", value: { effort: result.effort } });
    }
    return ops;
  }
  return ops;
}

// 入口钩子：只处理已知的 Kimi 系列模型，先校验再按需改写。
export function ingress(ctx, req) {
  const model = String(ctx.upstreamModel || ctx.model || "").toLowerCase();
  const family = kimiFamily(model);
  if (!family) return { action: "continue" };

  const body = req.body;
  if (!isObject(body)) return { action: "continue" };

  const result = inspect(ctx.format, body, req.media, family);
  // 不处理的协议或无法识别的请求体，原样放行。
  if (!result) return { action: "continue" };
  if (result.problem) return reject("kimi.invalid_request", result.problem);

  const ops = reasoningEffects(ctx.format, body, result, family);
  if (result.normalize && result.normalize.length > 0) {
    const contentOps = chatContentOps(body, result.normalize, MAX_PATCH_OPS - ops.length);
    if (!contentOps) {
      return reject(
        "kimi.invalid_request",
        "too many assistant messages with empty content and inline media to normalize in one request.",
      );
    }
    ops.push.apply(ops, contentOps);
  }
  if (ops.length === 0) return { action: "continue" };
  return { action: "continue", effects: [{ type: "json.patch", ops: ops }] };
}
