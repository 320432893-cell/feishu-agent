/**
 * ESLint 只开两条规则，不做风格。**唯一职责是抓「引用了不存在的名字」和「留着没人用的名字」** ——
 * `node --check` 只查语法，抓不出 `工具: name` 里 name 不在作用域这种（钩子静默抛 ReferenceError、
 * 结果照常返回，只有打真站那档几分钟后才红）；也抓不出删了函数留下的孤儿 import。
 * 实测本仓库一次删死码（2026-08-20 删 `日志大小` 之类）留下的孤儿 `statSync` import 就是它抓的。
 *
 * 风格类一条不开：这个仓库的取舍（中文标识符、长注释、内联三元）是有意的，
 * 让 linter 管风格只会制造一堆要豁免的噪音，而噪音会让人连真错也一起忽略。
 *
 * globals 手写而不是用 `globals` 包：那个包要 node_modules，而这个仓库是零 JS 依赖的。
 * 漏了哪个全局 `no-undef` 会误报 —— 误报就往这张表里加，别去关规则。
 */
export default [{
  files: ['**/*.mjs'],
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    globals: Object.fromEntries([
      'process', 'console', 'URL', 'URLSearchParams', 'Date', 'JSON', 'Math', 'Set', 'Map',
      'WeakMap', 'Promise', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Error', 'TypeError',
      'RegExp', 'Symbol', 'BigInt', 'Infinity', 'NaN', 'globalThis', 'structuredClone',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask',
      'TextEncoder', 'TextDecoder', 'Buffer', 'AbortController', 'AbortSignal', 'fetch', 'performance', 'crypto',
      'FormData', 'Blob',
    ].map((k) => [k, 'readonly'])),
  },
  rules: {
    'no-undef': 'error',
    // 参数不算：回调里为了对齐位置留个没用的参数是正常的
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    // **在 const 声明之前用它 = 运行时 ReferenceError**，而 `no-undef` 和 `node --check` 都放行。
    // 2026-08-22 在 bot.mjs 的答复分支上真踩过：那一句被外层 catch 吞成「卡住了」，日志里连堆栈都没有。
    // 只管变量和类，函数声明会提升、不受影响（`functions: false`）。
    'no-use-before-define': ['error', { functions: false, classes: true, variables: true }],
  },
}];
