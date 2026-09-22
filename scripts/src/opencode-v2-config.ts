import { isAbsolute, relative, resolve } from "node:path";
import { Config } from "@opencode/schema/config";
import { Schema } from "effect";
import { parseUserPolicy } from "../../packages/opencode-v2-plugin/src/user-policy.js";

type ObjectValue = Record<string, unknown>;
type SourcePath = readonly number[];
type Disposition = "mapped" | "externalized" | "redundant" | "blocked";
/** Definition assets only; the later loader must verify regular files/directories and symlink containment. */
type DefinitionMapping = {
  destination: string;
  mode: "read-only-reference" | "private-copy";
};

/** Context is reviewed, public planning metadata, never credentials or live configuration. */
export interface ConversionContext {
  sourceVersion: "1.18.29";
  root: string;
  sourceRoot: string;
  /** Reviewed absolute home for ~/ instruction paths only; never inferred from the process. */
  sourceHome?: string;
  runtime: {
    reflectionConfigPath: string;
    nativeConfigPath: string;
    userPolicyPath: string;
    dataPath: string;
    statePath: string;
    cachePath: string;
    v2Port: 4096;
    v1Port: 4097;
    v2Hostname: string;
  };
  reflectionNativeCompactionVeto: boolean;
  overrideCompactionAuto?: boolean;
  agentsDiscoveryHandled: boolean;
  /** Only these source strings may appear literally in the result (including dynamic keys). */
  publicStrings: readonly string[];
  executableMappings: Readonly<Record<string, string>>;
  /** Keys are original input strings, before home expansion or path normalization. */
  instructionMappings: Readonly<Record<string, DefinitionMapping>>;
  nativeReplacement: { identifiers: readonly string[]; directory: string };
  skills: {
    inventoryKnown: boolean;
    entries: readonly (DefinitionMapping & { source: string })[];
  };
  authUnavailableProviders?: readonly string[];
}

export interface ConversionResult {
  draftNativeConfig: ObjectValue;
  userPolicy: {
    version: 1;
    instructionFiles: string[];
    modelAllowlists: Record<string, string[]>;
    geminiOpenRouterToolGuard: true;
  };
  runtime: ConversionContext["runtime"] | null;
  assets: {
    kind: "instruction" | "skill" | "plugin";
    source?: string;
    destination: string;
    mode: "read-only-reference" | "private-copy" | "native-replacement";
  }[];
  /** Ordinal paths traverse Object.values(object) or array elements, never expose private keys. */
  secretSlots: {
    id: string;
    sourcePath: SourcePath;
    kind:
      | "text"
      | "argument"
      | "environment"
      | "header"
      | "url"
      | "oauth"
      | "setting";
    placeholder: string;
  }[];
  ledger: { sourcePath: SourcePath; disposition: Disposition }[];
  diagnostics: { code: string; fieldPath: SourcePath; blocking: boolean }[];
  nativeSchemaValid: boolean;
  userPolicyValid: boolean;
  conversionComplete: boolean;
  activationReady: false;
}

function object(value: unknown): value is ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function privatePath(root: string, path: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(path) || path.includes("\0"))
    return false;
  const diff = relative(resolve(root), resolve(path));
  return (
    diff !== "" && diff !== ".." && !diff.startsWith("../") && !isAbsolute(diff)
  );
}

/** Pure draft conversion. No filesystem, environment, network, credential lookup, or renderer. */
export function convertV1ToNative208(
  input: unknown,
  context: ConversionContext,
): ConversionResult {
  const result: ConversionResult = {
    draftNativeConfig: { compaction: { auto: false } },
    userPolicy: {
      version: 1,
      instructionFiles: [],
      modelAllowlists: Object.create(null),
      geminiOpenRouterToolGuard: true,
    },
    runtime: null,
    assets: [],
    secretSlots: [],
    ledger: [],
    diagnostics: [],
    nativeSchemaValid: false,
    userPolicyValid: false,
    conversionComplete: false,
    activationReady: false,
  };
  const draft = result.draftNativeConfig;
  const ledger = new Map<string, ConversionResult["ledger"][number]>();
  const publicStrings = new Set(context.publicStrings);
  const mark = (path: SourcePath, disposition: Disposition, deep = false) => {
    for (const entry of ledger.values()) {
      if (entry.sourcePath.length === path.length || deep) {
        if (
          path.every((part, i) => entry.sourcePath[i] === part) &&
          entry.sourcePath.length >= path.length
        )
          entry.disposition = disposition;
      }
    }
  };
  const diagnostic = (code: string, path: SourcePath, blocking = true) => {
    result.diagnostics.push({ code, fieldPath: [...path], blocking });
    if (blocking) mark(path, "blocked", true);
  };
  const child = (
    value: ObjectValue,
    path: SourcePath,
    key: string,
  ): SourcePath => [...path, Object.keys(value).indexOf(key)];
  const slot = (
    value: unknown,
    path: SourcePath,
    kind: ConversionResult["secretSlots"][number]["kind"],
  ): string => {
    if (typeof value !== "string" && kind !== "setting") {
      diagnostic("INVALID_STRING", path);
      return "INVALID_DRAFT";
    }
    const id = `slot-${result.secretSlots.length + 1}`;
    const placeholder = `__OPENCODE_PRIVATE_${id}__`;
    result.secretSlots.push({ id, sourcePath: [...path], kind, placeholder });
    mark(path, "externalized");
    return placeholder;
  };
  const declared = (value: unknown, path: SourcePath): value is string => {
    if (
      typeof value !== "string" ||
      !publicStrings.has(value) ||
      value.includes("\0")
    ) {
      diagnostic("PUBLIC_DECLARATION_REQUIRED", path);
      return false;
    }
    return true;
  };
  const fields = (
    value: unknown,
    path: SourcePath,
    handlers: Record<string, (value: unknown, path: SourcePath) => void>,
  ) => {
    if (!object(value)) {
      diagnostic("INVALID_OBJECT", path);
      return;
    }
    mark(path, "mapped");
    Object.entries(value).forEach(([key, item], index) => {
      const p = [...path, index];
      const handler = Object.hasOwn(handlers, key) ? handlers[key] : undefined;
      if (!handler) {
        diagnostic("UNHANDLED_FIELD", p);
        return;
      }
      mark(p, "mapped");
      handler(item, p);
    });
  };
  const records = (
    value: unknown,
    path: SourcePath,
    callback: (key: string, value: unknown, path: SourcePath) => void,
  ) => {
    if (!object(value)) {
      diagnostic("INVALID_OBJECT", path);
      return;
    }
    mark(path, "mapped");
    Object.entries(value).forEach(([key, item], i) => {
      const p = [...path, i];
      if (!declared(key, p)) return;
      mark(p, "mapped");
      callback(key, item, p);
    });
  };
  const number = (
    value: unknown,
    path: SourcePath,
    integer = false,
  ): value is number => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (integer && (!Number.isSafeInteger(value) || value < 0))
    ) {
      diagnostic("INVALID_NUMBER", path);
      return false;
    }
    return true;
  };
  const boolean = (value: unknown, path: SourcePath): value is boolean => {
    if (typeof value !== "boolean") {
      diagnostic("INVALID_BOOLEAN", path);
      return false;
    }
    return true;
  };
  const textMap = (
    value: unknown,
    path: SourcePath,
    kind: "environment" | "header",
  ) => {
    const out: ObjectValue = Object.create(null);
    records(value, path, (key, item, p) => {
      out[key] = slot(item, p, kind);
    });
    return out;
  };
  // Options are open JSON records. Unknown strings are slots, not presumed public credentials.
  const settings = (
    value: unknown,
    path: SourcePath,
    forcePrivate = false,
  ): unknown => {
    mark(path, "mapped");
    if (typeof value === "string")
      return !forcePrivate && publicStrings.has(value)
        ? value
        : slot(value, path, "setting");
    if (Array.isArray(value))
      return value.map((item, i) => settings(item, [...path, i], forcePrivate));
    if (object(value)) {
      const out: ObjectValue = Object.create(null);
      records(value, path, (key, item, p) => {
        out[key] = settings(
          item,
          p,
          forcePrivate ||
            /secret|token|password|authorization|api.?key|baseurl|endpoint/i.test(
              key,
            ),
        );
      });
      return out;
    }
    return forcePrivate ? slot(value, path, "setting") : value;
  };
  const selection = (
    value: unknown,
    variant: unknown,
    path: SourcePath,
  ): ObjectValue | undefined => {
    if (!declared(value, path) || !/^[^/#]+\/[^#]+$/.test(value)) {
      diagnostic("INVALID_MODEL_SELECTION", path);
      return;
    }
    const slash = value.indexOf("/");
    const selected: ObjectValue = {
      providerID: value.slice(0, slash),
      model: value.slice(slash + 1),
    };
    if (context.authUnavailableProviders?.includes(value.slice(0, slash)))
      diagnostic("PROVIDER_AUTH_PENDING", path, false);
    if (variant !== undefined) {
      if (!declared(variant, path) || !variant || variant.includes("#")) {
        diagnostic("INVALID_VARIANT", path);
        return;
      }
      selected.variant = variant;
    }
    return selected;
  };
  const permissions = (value: unknown, path: SourcePath) => {
    const rules: ObjectValue[] = [];
    const aliases: Record<string, string> = {
      bash: "shell",
      task: "subagent",
      write: "edit",
      patch: "edit",
    };
    const seen = new Map<string, { source: string; policy: string }>();
    const add = (
      action: string,
      resource: string,
      effect: unknown,
      p: SourcePath,
    ) => {
      if (effect !== "allow" && effect !== "deny" && effect !== "ask") {
        diagnostic("INVALID_PERMISSION", p);
        return;
      }
      rules.push({ action, resource, effect });
      mark(p, "mapped");
    };
    if (typeof value === "string") {
      add("*", "*", value, path);
      return rules;
    }
    records(value, path, (key, policy, p) => {
      const action = Object.hasOwn(aliases, key) ? aliases[key]! : key;
      const previous = seen.get(action);
      const serialized = JSON.stringify(policy);
      if (previous && previous.source !== key && previous.policy !== serialized)
        diagnostic("PERMISSION_RENAME_COLLISION", p);
      seen.set(action, { source: key, policy: serialized });
      if (key === "todowrite" || key === "todoread")
        diagnostic("UNMATCHED_LEGACY_ACTION", p, false);
      if (typeof policy === "string") add(action, "*", policy, p);
      else
        records(policy, p, (resource, effect, rp) =>
          add(action, resource, effect, rp),
        );
    });
    return rules;
  };

  // Validate plain JSON before walking it. Getters, cycles and non-JSON values never enter output.
  const active = new Set<object>();
  const inventory = (
    value: unknown,
    path: SourcePath,
    depth: number,
  ): boolean => {
    if (depth > 80 || ledger.size > 20000) return false;
    const entry = {
      sourcePath: [...path],
      disposition: "blocked" as Disposition,
    };
    ledger.set(path.join("/"), entry);
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return true;
    if (typeof value === "number") return Number.isFinite(value);
    if ((!object(value) && !Array.isArray(value)) || active.has(value))
      return false;
    if (Object.getOwnPropertySymbols(value).length) return false;
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(value);
    if (
      Array.isArray(value) &&
      (keys.length !== value.length || keys.some((key, i) => key !== String(i)))
    )
      return false;
    for (const [i, key] of keys.entries()) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !inventory(descriptor.value, [...path, i], depth + 1)
      )
        return false;
    }
    active.delete(value);
    return true;
  };
  try {
    if (!inventory(input, [], 0) || !object(input)) {
      diagnostic("INVALID_JSON_INPUT", []);
      result.ledger = [...ledger.values()];
      return result;
    }
  } catch {
    diagnostic("INVALID_JSON_INPUT", []);
    result.ledger = [...ledger.values()];
    return result;
  }

  if (context.sourceVersion !== "1.18.29")
    diagnostic("SOURCE_VERSION_REQUIRED", []);
  const runtimePaths = [
    context.runtime.reflectionConfigPath,
    context.runtime.nativeConfigPath,
    context.runtime.userPolicyPath,
    context.runtime.dataPath,
    context.runtime.statePath,
    context.runtime.cachePath,
  ];
  const rootValid =
    isAbsolute(context.root) &&
    isAbsolute(context.sourceRoot) &&
    resolve(context.root) !== resolve(context.sourceRoot) &&
    !privatePath(context.sourceRoot, context.root) &&
    !privatePath(context.root, context.sourceRoot);
  if (
    !rootValid ||
    runtimePaths.some(
      (path) => typeof path !== "string" || !privatePath(context.root, path),
    ) ||
    new Set(runtimePaths.map((path) => resolve(String(path)))).size !==
      runtimePaths.length ||
    context.runtime.v2Port !== 4096 ||
    context.runtime.v1Port !== 4097 ||
    typeof context.runtime.v2Hostname !== "string" ||
    !context.runtime.v2Hostname.trim() ||
    context.runtime.v2Hostname.includes("\0")
  )
    diagnostic("ISOLATED_RUNTIME_REQUIRED", []);
  else result.runtime = { ...context.runtime };
  if (!context.reflectionNativeCompactionVeto)
    diagnostic("REFLECTION_VETO_REQUIRED", []);
  if (!context.agentsDiscoveryHandled)
    diagnostic("AGENTS_DISCOVERY_PROOF_REQUIRED", []);
  if (!context.skills.inventoryKnown)
    diagnostic("SKILLS_INVENTORY_REQUIRED", []);
  draft.skills = [];
  for (const entry of context.skills.entries) {
    if (
      !privatePath(context.sourceRoot, entry.source) ||
      !relative(context.sourceRoot, entry.source).startsWith("skills/") ||
      /[*?\[\]{}\0]/.test(entry.source) ||
      (entry.mode === "read-only-reference"
        ? !isAbsolute(entry.destination) ||
          resolve(entry.source) !== resolve(entry.destination)
        : entry.mode !== "private-copy" ||
          !privatePath(context.root, entry.destination) ||
          relative(context.sourceRoot, entry.source) !==
            relative(context.root, entry.destination))
    ) {
      diagnostic("SKILL_LAYOUT_MAPPING_REQUIRED", []);
      continue;
    }
    const destination = resolve(entry.destination);
    if ((draft.skills as string[]).includes(destination)) continue;
    (draft.skills as string[]).push(destination);
    if (entry.mode === "private-copy")
      diagnostic("SKILL_COPY_NOT_LIVE_PARITY", [], false);
    result.assets.push({
      kind: "skill",
      source: entry.source,
      destination,
      mode: entry.mode,
    });
  }
  if (!privatePath(context.root, context.nativeReplacement.directory))
    diagnostic("PLUGIN_MAPPING_REQUIRED", []);
  else {
    draft.plugins = [
      {
        package: context.nativeReplacement.directory,
        options: {
          configPath: context.runtime.reflectionConfigPath,
          userPolicyPath: context.runtime.userPolicyPath,
        },
      },
    ];
    result.assets.push({
      kind: "plugin",
      destination: context.nativeReplacement.directory,
      mode: "native-replacement",
    });
  }

  let globalTimeout: number | undefined;
  if (
    object(input.experimental) &&
    input.experimental.mcp_timeout !== undefined
  ) {
    const p = child(
      input.experimental,
      child(input, [], "experimental"),
      "mcp_timeout",
    );
    if (
      number(input.experimental.mcp_timeout, p, true) &&
      input.experimental.mcp_timeout > 0
    )
      globalTimeout = input.experimental.mcp_timeout;
    else diagnostic("INVALID_TIMEOUT", p);
  }
  const empty = (value: unknown, path: SourcePath) => {
    if (!object(value) || Object.keys(value).length)
      diagnostic("UNSUPPORTED_NONEMPTY_FIELD", path);
    else mark(path, "redundant");
  };
  const enabledProviders: ObjectValue[] = [];
  const disabledProviders: ObjectValue[] = [];
  const providerPolicies = (
    value: unknown,
    path: SourcePath,
    effect: "allow" | "deny",
    output: ObjectValue[],
  ) => {
    if (!Array.isArray(value)) {
      diagnostic("INVALID_ARRAY", path);
      return;
    }
    value.forEach((id, i) => {
      const p = [...path, i];
      if (!declared(id, p)) return;
      // 7673ed6 core/src/v1/config/migrate.ts: providerID and experimental.
      const resource =
        id === "azure-cognitive-services"
          ? "azure"
          : id === "google-vertex-anthropic"
            ? "google-vertex"
            : id;
      output.push({ action: "provider.use", resource, effect });
      mark(p, "mapped");
    });
  };
  fields(input, [], {
    $schema: (value, p) => {
      if (typeof value !== "string") diagnostic("INVALID_STRING", p);
      else mark(p, "redundant");
    },
    model: (value, p) => {
      const selected = selection(value, undefined, p);
      if (selected) draft.model = selected;
    },
    username: (value, p) => {
      draft.username = slot(value, p, "text");
    },
    default_agent: (value, p) => {
      if (declared(value, p)) draft.default_agent = value;
    },
    snapshot: (value, p) => {
      if (boolean(value, p)) draft.snapshots = value;
    },
    autoupdate: (value, p) => {
      if (value === true || value === false || value === "notify")
        draft.update =
          value === true ? "auto" : value === false ? "disable" : value;
      else diagnostic("INVALID_UPDATE", p);
    },
    share: (value, p) => {
      if (value === "auto" || value === "manual" || value === "disabled")
        draft.share = value;
      else diagnostic("INVALID_SHARE", p);
    },
    permission: (value, p) => {
      draft.permissions = permissions(value, p);
    },
    command: empty,
    commands: empty,
    mode: empty,
    server: (value, p) =>
      fields(value, p, {
        port: (v, q) => {
          if (number(v, q, true) && v > 0 && v <= 65535) {
            mark(q, "externalized");
            diagnostic("FINAL_PORTS_FROM_CONTEXT", q, false);
          } else diagnostic("INVALID_PORT", q);
        },
        hostname: (v, q) => {
          if (typeof v !== "string" || !v.trim() || v.includes("\0"))
            diagnostic("INVALID_HOSTNAME", q);
          else {
            mark(q, "externalized");
            diagnostic("FINAL_BINDING_FROM_CONTEXT", q, false);
          }
        },
      }),
    experimental: (value, p) =>
      fields(value, p, {
        mcp_timeout: (v, q) => {
          if (!number(v, q, true) || v <= 0) diagnostic("INVALID_TIMEOUT", q);
        },
      }),
    enabled_providers: (value, p) =>
      providerPolicies(value, p, "allow", enabledProviders),
    disabled_providers: (value, p) =>
      providerPolicies(value, p, "deny", disabledProviders),
    instructions: (value, p) => {
      if (!Array.isArray(value)) {
        diagnostic("INVALID_ARRAY", p);
        return;
      }
      value.forEach((source, i) => {
        const q = [...p, i];
        if (!declared(source, q)) return;
        let expandedSource = source;
        if (source.startsWith("~/")) {
          if (
            typeof context.sourceHome !== "string" ||
            !isAbsolute(context.sourceHome) ||
            /[\0*?\[\]{}]/.test(context.sourceHome) ||
            context.sourceHome.includes("://")
          ) {
            diagnostic("SOURCE_HOME_REQUIRED", q);
            return;
          }
          expandedSource = resolve(context.sourceHome, `./${source.slice(2)}`);
        }
        const mapping = context.instructionMappings[source];
        if (
          !privatePath(context.sourceRoot, expandedSource) ||
          /[*?\[\]{}]/.test(source) ||
          source.includes("://") ||
          !/\.(md|txt)$/i.test(source) ||
          !mapping ||
          (mapping.mode === "read-only-reference"
            ? !isAbsolute(mapping.destination) ||
              resolve(expandedSource) !== resolve(mapping.destination)
            : mapping.mode !== "private-copy" ||
              !privatePath(context.root, mapping.destination))
        ) {
          diagnostic("INSTRUCTION_MAPPING_REQUIRED", q);
          return;
        }
        const destination = resolve(mapping.destination);
        if (mapping.mode === "private-copy")
          diagnostic("INSTRUCTION_COPY_NOT_LIVE_PARITY", q, false);
        if (!result.userPolicy.instructionFiles.includes(destination)) {
          result.userPolicy.instructionFiles.push(destination);
        }
        // Keep distinct sources for collision checking even when the profile path deduplicates.
        if (
          !result.assets.some(
            (asset) =>
              asset.kind === "instruction" &&
              asset.source === resolve(expandedSource) &&
              asset.destination === destination,
          )
        ) {
          result.assets.push({
            kind: "instruction",
            source: resolve(expandedSource),
            destination,
            mode: mapping.mode,
          });
        }
        mark(q, "externalized");
      });
    },
    plugin: (value, p) => {
      if (!Array.isArray(value)) {
        diagnostic("INVALID_ARRAY", p);
        return;
      }
      value.forEach((id, i) => {
        const q = [...p, i];
        if (
          typeof id !== "string" ||
          !context.nativeReplacement.identifiers.includes(id)
        )
          diagnostic("UNKNOWN_PLUGIN", q);
        else mark(q, "externalized");
      });
    },
    compaction: (value, p) =>
      fields(value, p, {
        auto: (v, q) => {
          if (!boolean(v, q)) return;
          if (v && !context.overrideCompactionAuto)
            diagnostic("COMPACTION_POLICY_CONFLICT", q);
          else if (v) {
            mark(q, "externalized");
            diagnostic("COMPACTION_POLICY_OVERRIDE", q, false);
          }
        },
        preserve_recent_tokens: (v, q) => {
          if (number(v, q, true))
            (draft.compaction as ObjectValue).keep = { tokens: v };
        },
        tail_turns: (v, q) => {
          if (!number(v, q, true)) return;
          if (
            object(value) &&
            value.auto === false &&
            context.reflectionNativeCompactionVeto
          ) {
            mark(q, "redundant");
            diagnostic("INACTIVE_NOT_NATIVE_EQUIVALENT", q, false);
          } else diagnostic("UNSUPPORTED_TAIL_TURNS", q);
        },
      }),
    agent: (value, p) => {
      const agents: ObjectValue = Object.create(null);
      draft.agents = agents;
      records(value, p, (id, agent, q) => {
        const out: ObjectValue = {};
        agents[id] = out;
        const body: ObjectValue = Object.create(null);
        fields(agent, q, {
          name: (v, r) => {
            if (v === id) mark(r, "redundant");
            else diagnostic("AGENT_NAME_CONFLICT", r);
          },
          model: (v, r) => {
            const selected = selection(
              v,
              object(agent) ? agent.variant : undefined,
              r,
            );
            if (selected) out.model = selected;
          },
          variant: (v, r) => {
            if (
              !object(agent) ||
              !agent.model ||
              !declared(v, r) ||
              !v ||
              v.includes("#")
            )
              diagnostic("INVALID_VARIANT", r);
          },
          prompt: (v, r) => {
            out.system = slot(v, r, "text");
          },
          description: (v, r) => {
            out.description = slot(v, r, "text");
          },
          disable: (v, r) => {
            if (boolean(v, r)) out.disabled = v;
          },
          hidden: (v, r) => {
            if (boolean(v, r)) out.hidden = v;
          },
          mode: (v, r) => {
            if (v === "primary" || v === "subagent" || v === "all")
              out.mode = v;
            else diagnostic("INVALID_AGENT_MODE", r);
          },
          color: (v, r) => {
            if (typeof v === "string" && /^#[\da-f]{6}$/i.test(v))
              out.color = v;
            else diagnostic("UNSUPPORTED_AGENT_COLOR", r);
          },
          steps: (v, r) => {
            if (number(v, r, true) && v > 0) out.steps = v;
            else diagnostic("INVALID_STEPS", r);
          },
          permission: (v, r) => {
            out.permissions = permissions(v, r);
          },
          options: (v, r) =>
            records(v, r, (key, item, s) => {
              // 7673ed6 migrateAgent overlays raw HTTP request.body, not GenerationOptions.
              // OpenAI/OpenRouter wire protocols use top_p; topP needs a separate mapping.
              if (key === "topP") {
                diagnostic("UNSUPPORTED_AGENT_TOP_P_CAMEL_CASE", s);
                return;
              }
              if (
                (key === "temperature" || key === "top_p") &&
                object(agent) &&
                Object.hasOwn(agent, key)
              )
                mark(s, "redundant", true);
              else
                body[key] = settings(
                  item,
                  s,
                  /secret|token|password|authorization|api.?key|baseurl|endpoint/i.test(
                    key,
                  ),
                );
            }),
          temperature: (v, r) => {
            if (!number(v, r)) return;
          },
          top_p: (v, r) => {
            if (!number(v, r)) return;
          },
        });
        if (object(agent))
          for (const key of ["temperature", "top_p"]) {
            if (typeof agent[key] === "number") {
              body[key] = agent[key];
              if (object(agent.options) && Object.hasOwn(agent.options, key))
                mark(
                  child(agent.options, child(agent, q, "options"), key),
                  "redundant",
                  true,
                );
            }
          }
        if (Object.keys(body).length) out.request = { body };
      });
    },
    provider: (value, p) => {
      const providers: ObjectValue = Object.create(null);
      draft.providers = providers;
      records(value, p, (id, provider, q) => {
        const out: ObjectValue = {};
        providers[id] = out;
        if (id !== "openai" && id !== "openrouter")
          diagnostic("UNREVIEWED_PROVIDER_MAPPING", q);
        if (context.authUnavailableProviders?.includes(id))
          diagnostic("PROVIDER_AUTH_PENDING", q, false);
        let endpoint: string | undefined;
        fields(provider, q, {
          id: (v, r) => {
            if (v === id) mark(r, "redundant");
            else diagnostic("PROVIDER_ID_CONFLICT", r);
          },
          npm: (v, r) => {
            if (
              (id === "openai" && v === "@ai-sdk/openai") ||
              (id === "openrouter" && v === "@openrouter/ai-sdk-provider")
            ) {
              mark(r, "redundant");
              diagnostic("NATIVE_BUILTIN_PROVIDER_PACKAGE", r, false);
            } else diagnostic("UNREVIEWED_PROVIDER_PACKAGE", r);
          },
          api: (v, r) => {
            endpoint = slot(v, r, "setting");
            if (typeof v !== "string") diagnostic("INVALID_STRING", r);
            if (
              object(provider) &&
              object(provider.options) &&
              Object.hasOwn(provider.options, "baseURL") &&
              provider.options.baseURL !== v
            )
              diagnostic("PROVIDER_ENDPOINT_CONFLICT", r);
          },
          env: (v, r) => {
            if (!Array.isArray(v)) {
              diagnostic("INVALID_ARRAY", r);
              return;
            }
            const names: string[] = [];
            out.env = names;
            v.forEach((name, i) => {
              const s = [...r, i];
              if (declared(name, s) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
                names.push(name);
                mark(s, "mapped");
              } else diagnostic("INVALID_ENV_NAME", s);
            });
          },
          name: (v, r) => {
            out.name = slot(v, r, "text");
          },
          whitelist: (v, r) => {
            if (!Array.isArray(v)) {
              diagnostic("INVALID_ARRAY", r);
              return;
            }
            const list: string[] = [];
            result.userPolicy.modelAllowlists[id] = list;
            v.forEach((model, i) => {
              const s = [...r, i];
              if (declared(model, s)) {
                list.push(model);
                mark(s, "externalized");
              }
            });
            mark(r, "externalized");
          },
          blacklist: (_v, r) => diagnostic("UNSUPPORTED_PROVIDER_BLACKLIST", r),
          options: (v, r) => {
            const config: ObjectValue = Object.create(null);
            out.settings = config;
            records(v, r, (key, item, s) => {
              if (key === "headers") out.headers = textMap(item, s, "header");
              else if (key === "body") {
                if (!object(item)) diagnostic("INVALID_OBJECT", s);
                else out.body = settings(item, s);
              } else {
                if (
                  ["apiKey", "baseURL", "enterpriseUrl"].includes(key) &&
                  typeof item !== "string"
                )
                  diagnostic("INVALID_STRING", s);
                if (key === "setCacheKey") boolean(item, s);
                if (
                  ["timeout", "headerTimeout", "chunkTimeout"].includes(key) &&
                  !(item === false && key !== "chunkTimeout")
                ) {
                  if (!number(item, s, true) || item <= 0)
                    diagnostic("INVALID_TIMEOUT", s);
                }
                if (
                  key === "baseURL" &&
                  object(provider) &&
                  typeof provider.api === "string" &&
                  provider.api === item
                )
                  mark(s, "redundant");
                else
                  config[key] = settings(
                    item,
                    s,
                    /secret|token|password|authorization|api.?key|baseurl|endpoint/i.test(
                      key,
                    ),
                  );
              }
            });
          },
          models: (v, r) => {
            const models: ObjectValue = Object.create(null);
            out.models = models;
            records(v, r, (model, info, s) => {
              const entry: ObjectValue = {};
              models[model] = entry;
              fields(info, s, {
                name: (w, t) => {
                  entry.name = slot(w, t, "text");
                },
                options: (w, t) => {
                  if (!object(w)) diagnostic("INVALID_OBJECT", t);
                  else entry.settings = settings(w, t);
                },
                limit: (w, t) => {
                  const limit: ObjectValue = {};
                  entry.limit = limit;
                  fields(
                    w,
                    t,
                    Object.fromEntries(
                      ["context", "input", "output"].map((key) => [
                        key,
                        (n: unknown, u: SourcePath) => {
                          if (number(n, u, true)) limit[key] = n;
                        },
                      ]),
                    ),
                  );
                },
              });
            });
          },
        });
        if (endpoint !== undefined) {
          if (!object(out.settings)) out.settings = {};
          (out.settings as ObjectValue).baseURL = endpoint;
          if (
            object(provider) &&
            object(provider.options) &&
            provider.options.baseURL === provider.api
          )
            mark(
              child(provider.options, child(provider, q, "options"), "baseURL"),
              "redundant",
              true,
            );
        }
      });
    },
    mcp: (value, p) => {
      const servers: ObjectValue = Object.create(null);
      draft.mcp = {
        timeout: {
          startup: 30000,
          catalog: 30000,
          execution: globalTimeout ?? 60000,
        },
        servers,
      };
      records(value, p, (id, server, q) => {
        if (
          !object(server) ||
          (server.type !== "local" && server.type !== "remote")
        ) {
          diagnostic("MCP_FULL_DEFINITION_REQUIRED", q);
          return;
        }
        const out: ObjectValue = {
          type: server.type,
          codemode: false,
          timeout: {
            startup: 30000,
            catalog: 30000,
            execution: globalTimeout ?? 60000,
          },
        };
        servers[id] = out;
        const common = {
          type: () => {},
          enabled: (v: unknown, r: SourcePath) => {
            if (boolean(v, r)) out.disabled = !v;
          },
          timeout: (v: unknown, r: SourcePath) => {
            if (number(v, r, true) && v > 0)
              out.timeout = { startup: v, catalog: v, execution: v };
            else diagnostic("INVALID_TIMEOUT", r);
          },
        };
        if (server.type === "local")
          fields(server, q, {
            ...common,
            command: (v, r) => {
              if (!Array.isArray(v) || !v.length || typeof v[0] !== "string") {
                diagnostic("INVALID_COMMAND", r);
                return;
              }
              const executable = context.executableMappings[v[0]];
              if (
                !executable ||
                !isAbsolute(executable) ||
                executable.includes("\0")
              ) {
                diagnostic("EXECUTABLE_MAPPING_REQUIRED", [...r, 0]);
                return;
              }
              mark([...r, 0], "externalized");
              out.command = [
                executable,
                ...v
                  .slice(1)
                  .map((arg, i) => slot(arg, [...r, i + 1], "argument")),
              ];
            },
            environment: (v, r) => {
              out.environment = textMap(v, r, "environment");
            },
            cwd: (v, r) => {
              out.cwd = slot(v, r, "text");
            },
          });
        else {
          diagnostic("MCP_TRANSPORT_PARITY_UNVERIFIED", q, false);
          if (server.oauth !== false)
            diagnostic("MCP_OAUTH_AUTH_PENDING", q, false);
          fields(server, q, {
            ...common,
            url: (v, r) => {
              out.url = slot(v, r, "url");
            },
            headers: (v, r) => {
              out.headers = textMap(v, r, "header");
            },
            oauth: (v, r) => {
              if (v === false) {
                out.oauth = false;
                return;
              }
              const oauth: ObjectValue = {};
              out.oauth = oauth;
              fields(
                v,
                r,
                Object.fromEntries(
                  Object.entries({
                    clientId: "client_id",
                    clientSecret: "client_secret",
                    scope: "scope",
                    redirectUri: "redirect_uri",
                    callbackPort: "callback_port",
                  }).map(([from, to]) => [
                    from,
                    (w: unknown, s: SourcePath) => {
                      if (from === "callbackPort") {
                        if (number(w, s, true) && w > 0 && w <= 65535)
                          oauth[to] = w;
                        else diagnostic("INVALID_PORT", s);
                      } else oauth[to] = slot(w, s, "oauth");
                    },
                  ]),
                ),
              );
            },
          });
        }
        diagnostic("MCP_PROGRESS_RESET_PARITY_UNVERIFIED", q, false);
      });
    },
  });
  // Native normalization order is independent of the source object's property order.
  if (
    Object.hasOwn(input, "enabled_providers") ||
    Object.hasOwn(input, "disabled_providers")
  ) {
    draft.experimental = {
      policies: [
        ...(Object.hasOwn(input, "enabled_providers")
          ? [{ action: "provider.use", resource: "*", effect: "deny" }]
          : []),
        ...enabledProviders,
        ...disabledProviders,
      ],
    };
  }
  if (!draft.mcp)
    draft.mcp = {
      timeout: {
        startup: 30000,
        catalog: 30000,
        execution: globalTimeout ?? 60000,
      },
    };
  const destinations = new Map<string, string | undefined>();
  for (const asset of result.assets) {
    const destination = resolve(asset.destination);
    if (
      runtimePaths.some(
        (path) => typeof path === "string" && resolve(path) === destination,
      ) ||
      (destinations.has(destination) &&
        destinations.get(destination) !== asset.source)
    )
      diagnostic("MANIFEST_DESTINATION_CONFLICT", []);
    destinations.set(destination, asset.source);
  }
  try {
    Schema.decodeUnknownSync(Config.Info, { onExcessProperty: "error" })(draft);
    result.nativeSchemaValid = true;
  } catch {
    diagnostic("NATIVE_SCHEMA_INVALID", []);
  }
  try {
    parseUserPolicy(result.userPolicy);
    result.userPolicyValid = true;
  } catch {
    diagnostic("USER_POLICY_INVALID", []);
  }
  // Later sibling mappings must never erase a blocking field's disposition.
  for (const entry of result.diagnostics)
    if (entry.blocking) mark(entry.fieldPath, "blocked", true);
  result.ledger = [...ledger.values()];
  result.conversionComplete =
    result.nativeSchemaValid &&
    result.userPolicyValid &&
    !result.diagnostics.some((d) => d.blocking) &&
    result.ledger.every((entry) => entry.disposition !== "blocked");
  return result;
}
