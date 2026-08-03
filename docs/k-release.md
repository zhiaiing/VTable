# `k-vtable` / `k-react-vtable` 发布说明

这两个包通过独立发布层生成。源码仍保持上游身份：

```text
packages/vtable       -> @visactor/vtable
packages/react-vtable -> @visactor/react-vtable
```

不要在 React 源码、Rush 项目名或源码 `package.json` 中长期维护 `k-*` 改名。`scripts/k-release.mjs` 只修改复制到根目录 `release/` 的构建产物。

## 环境要求

- Node.js 必须满足 `rush.json` 的支持范围。
- Rush 和 pnpm 由 `common/scripts/install-run-rush*.js` 按仓库配置加载；当前 pnpm 为 10.7.0。
- `pack` 需要网络访问以创建全新消费项目。
- 浏览器门禁需要本机安装 Google Chrome、Chromium 或 Microsoft Edge。
- npm 发布前需要已登录目标 registry。

## 1. 生成发布目录

```bash
node scripts/k-release.mjs prepare --version 1.0.40
```

默认先执行：

```bash
node common/scripts/install-run-rush.js build -t @visactor/react-vtable
```

随后生成：

```text
release/k-vtable/
release/k-react-vtable/
artifacts/k-release-1.0.40.prepare.json
```

在已经完成同一源码构建的调试或 CI 阶段可以使用：

```bash
node scripts/k-release.mjs prepare --version 1.0.40 --skip-build
```

`--skip-build` 仍会检查 ESM、CJS、类型入口和构建版本；过期产物会直接失败。

发布 manifest 会执行以下转换：

- `@visactor/vtable` 改名为 `k-vtable`。
- `@visactor/react-vtable` 改名为 `k-react-vtable`。
- React ESM/类型中的精确 `@visactor/vtable/es/*` 改为 `k-vtable/es/*`，CJS JavaScript 中则改为 `k-vtable/cjs/*`，避免 Node require 进入深层 ESM 文件。
- `k-react-vtable` 删除原始核心依赖，改用与发布版本完全一致的 `k-vtable` peer dependency。
- `k-react-vtable` 删除上游的条件 `exports`；Node ESM 回退到 `main` 的 CJS 入口，bundler 仍通过 `module` 使用 ESM，避免 Node 直接执行含无扩展名相对导入的 Rollup ESM 产物。
- VRender 五个运行时包统一固定为 1.1.5。
- 两个入口及 source map 中导出的版本改为命令行版本。
- 不复制或发布 `dist/` UMD 文件。

## 2. Pack 和全新消费验证

```bash
node scripts/k-release.mjs pack --version 1.0.40
```

必须先存在同版本、同源码状态的 prepare 结果。该命令会：

1. 使用 `npm pack --dry-run --json` 验证文件白名单。
2. 将两个精确 tarball 写入 `artifacts/`。
3. 在系统临时目录创建全新消费项目。
4. 使用仓库固定的 pnpm 安装两个 tarball、React 18 和 `@visactor/vchart@2.1.3`。
5. 验证所有 VRender 包只有 1.1.5 一个版本，且只有一个 `k-vtable` 核心身份。
6. 验证 CJS、ESM、TypeScript 公开类型和深层类型入口。TypeScript 门禁启用 `skipLibCheck`，用于验证消费代码与入口解析，不把 VChart/VRender 上游声明文件内部错误误判为改名回归。
7. 使用 Vite build 和系统 Chrome headless 运行 ListTable、React 自定义布局、冻结行和 PivotChart。
8. 确认没有 CanvasFactory/Context2dFactory 错误后写入 `artifacts/k-release-1.0.40.pack.json`。

任一消费测试失败时不会生成通过状态，tarball 不得发布。

## 3. 显式发布

```bash
node scripts/k-release.mjs publish --version 1.0.40 --tag latest
```

指定 registry：

```bash
node scripts/k-release.mjs publish \
  --version 1.0.40 \
  --tag latest \
  --registry https://registry.npmjs.org/
```

publish 会验证：

- pack 状态属于当前版本和源码提交。
- 两个精确 tarball 仍存在并带有 integrity/shasum。
- `npm whoami` 成功。
- 首次发布时两个目标版本都不存在。

发布顺序固定为：

1. `k-vtable`
2. 等待 registry 返回相同 integrity
3. `k-react-vtable`
4. 等待 registry 返回相同 integrity

如果核心包成功但 React 包失败，可以重新执行同一条 publish 命令。只有 registry 上核心包的 `dist.integrity` 与本地 pack 状态完全一致时，脚本才会跳过核心包并续发 React 包。

脚本不会执行 Git commit、tag、push、rebase、自动 unpublish 或 npm 版本覆盖。版本已经完整发布后再次执行会失败；缺陷修复应递增 patch 版本。

## 常见失败

### `CanvasFactory is not configured`

检查 pack 输出中的依赖图。`@visactor/vrender`、core、kits、components 和 animate 必须全部只有 1.1.5。不要通过在 React bundler 中内嵌另一份 VTable 来规避依赖问题。

### prepare 找不到源码版本

构建产物已过期，或上游改变了版本注入格式。重新执行不带 `--skip-build` 的 prepare；不要手工无约束替换构建文件。

### 找不到 Chrome

安装 Chrome/Chromium/Edge 后重新执行 pack。浏览器门禁用于复现 VRender 全局注册冲突，不能用仅 Node 的测试替代。

### 核心已发布、React 失败

保留原 `artifacts/k-release-<version>.pack.json` 和 tarball，修复登录或 registry 问题后重试 publish。若核心 integrity 不一致，停止续发并使用新的 patch 版本。
