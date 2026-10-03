import type { ContainerRuntime } from "./runtime.js";
import { RecoveringContainerRuntime, type RecoveringRuntimeOptions } from "./recovering-runtime.js";

export type ContainerRuntimeProvider<T extends ContainerRuntime = ContainerRuntime> = () => T;

export type ContainerRuntimeFactoryOptions<T extends ContainerRuntime = ContainerRuntime> = {
  provider?: string;
  providers: Record<string, ContainerRuntimeProvider<T> | undefined>;
  recovery?: false | RecoveringRuntimeOptions;
};

const lifecycleMethods = new Set<PropertyKey>([
  "ping", "ensureNetwork", "ensureImage", "createAndStart", "stop", "remove",
  "inspect", "list", "exec", "execStdio", "attachStdio", "logs", "buildSpecName", "close",
]);
const optionalMethods = new Set<PropertyKey>(["execStdio", "attachStdio", "close"]);

/**
 * Selects a runtime provider and overlays recovery semantics while retaining
 * the concrete adapter's prototype, extra public methods, and instanceof
 * behavior. This lets a DockerRuntime remain a DockerRuntime at integration
 * boundaries rather than forcing server code to depend on the decorator type.
 */
export function createContainerRuntime<T extends ContainerRuntime>(options: ContainerRuntimeFactoryOptions<T>): T {
  const providerName = options.provider ?? "docker";
  const provider = options.providers[providerName];
  if (!provider) throw new Error(`Unknown container runtime provider: ${providerName}`);
  const runtime = provider();
  if (!runtime || typeof runtime.createAndStart !== "function") {
    throw new Error(`Container runtime provider ${providerName} returned an invalid adapter`);
  }
  if (options.recovery === false) return runtime;

  const recovering = new RecoveringContainerRuntime(runtime, options.recovery);
  return new Proxy(runtime, {
    get(target, property) {
      if (lifecycleMethods.has(property)) {
        if (optionalMethods.has(property) && Reflect.get(target, property, target) === undefined) return undefined;
        const value = Reflect.get(recovering, property, recovering);
        if (typeof value === "function") return value.bind(recovering);
        if (value !== undefined) return value;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
