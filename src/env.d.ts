declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

/** Released version (git tag), injected at build time by vite.config.ts. */
declare const __APP_VERSION__: string;
