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
- staged publish（`--stage` / `stages` / `stage-approve`）要求 **npm 11.15.0+ 且 Node 22.14.0+**，账号需开启 2FA；脚本会在 `--stage` 前显式校验版本并给出明确报错。

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

## 3. 显式发布（按包分别执行）

`pack` 仍然一次产出两个 tarball，但发布拆成两条命令，各自只处理一个包：

```bash
node scripts/k-release.mjs publish --version 1.0.40 --tag latest --package k-vtable
node scripts/k-release.mjs publish --version 1.0.40 --tag latest --package k-react-vtable
```

指定 registry：

```bash
node scripts/k-release.mjs publish \
  --version 1.0.40 \
  --tag latest \
  --package k-vtable \
  --registry https://registry.npmjs.org/
```

`--package` 只接受 `k-vtable` 或 `k-react-vtable`，且为 publish 的必填项；pack/prepare 仍然一次处理两个包。

每条 publish 会验证：

- `artifacts/k-release-<version>.pack.json` 属于当前版本和源码提交，且 `testsPassed` 为真。
- 目标包 tarball 仍存在并带有 integrity/shasum。
- `npm whoami` 成功。
- 目标包版本尚未发布；若已发布，integrity 必须与本地 pack 状态一致。

发布单个包的流程：

1. `npm publish <tarball> --tag <tag>`
2. 等待 registry 返回相同 integrity
3. 写入 `artifacts/k-release-<version>-<package>.published.json`（记录 package、版本、tag、integrity、shasum、首次发布时间、`stagedVia` 发布方式）

两条命令相互独立，可以先发 `k-vtable`、隔一段时间再发 `k-react-vtable`，顺序不再强制。目标包若已发布且 integrity 一致，命令按成功处理并只刷新状态文件（`published: false`），因此上一次中断可以安全重跑；若 integrity 不一致则直接失败，提示改用新的 patch 版本。

需要交互式 2FA 时追加 `--otp <code>`：

```bash
node scripts/k-release.mjs publish --version 1.0.40 --tag latest --package k-vtable --otp 123456
```

### 3.1 走 staged publish（先暂存、后批准）

npm 官方的 staged publish 流程是 `npm stage publish` → 人工 review → `npm stage approve`（批准时才要求 2FA）。同一套流程在脚本里通过 `--stage` 完成：

```bash
# 只暂存，不发布（不需要 2FA），命令结束会返回 stage id 和下一步命令
node scripts/k-release.mjs publish --version 1.0.40 --tag latest --package k-vtable --stage
```

输出形如：

```json
{
  "packageName": "k-vtable",
  "version": "1.0.40",
  "staged": true,
  "stageId": "<stage-id>",
  "published": false,
  "next": "node scripts/k-release.mjs stage-approve --stage-id <stage-id> --version 1.0.40"
}
```

review 后再批准（此步需要 2FA）：

```bash
node scripts/k-release.mjs stages                                  # 列出暂存条目
node scripts/k-release.mjs stages --stage-id <stage-id>            # 查看单条暂存详情
npm stage download <stage-id>                                      # 下载暂存 tarball 核对
node scripts/k-release.mjs stage-approve --stage-id <stage-id> --version 1.0.40
```

`--otp` 可用可不用：不传时 npm 会在终端交互提示输入 6 位验证码（推荐，验证码不会进 shell history）；传的话必须是当时验证器上的真实码，且 30 秒内有效。

`stage-approve` 会先执行 `npm stage view <stage-id>` 核对再批准：

- stage id 失效（已被 approve/reject、或不属于当前 registry）时报错并提示用 `stages` 重新获取，**不会**进入 approve 流程。
- 给了 `--version` 但 stage 条目的版本与之不符时，**中止 approve** 并同时打印两个版本，避免批准错版本。
- 不给 `--version` 时只 approve、不做发布后校验（`--version` 仅影响校验和返回信息，approve 本身只认 stage id）。

也可以一步完成（仍会在 approve 时要求 2FA，等价于直接 `npm publish` 但多一次暂存）：

```bash
node scripts/k-release.mjs publish --version 1.0.40 --tag latest --package k-vtable --stage --approve --otp 123456
```

约定与限制（与 npm 官方一致）：

- `--stage` 只用于 publish；`--approve` 必须与 `--stage` 同时出现，单独使用会被拒绝（2FA 是设计上刻意延后的一步）。
- `--otp` 是 6 位一次性验证码，不是密码；文档与示例里的 `123456` 只是占位符，照抄必然失败。
- 暂存与正式发布共用同一个 semver 唯一索引：同一版本被 staged 后，未 approve/reject 之前无法再用 `npm publish` 发布，重复提交会得到 `E409 Cannot publish over previously staged version`。
- tag 是暂存条目的不可变属性；要换 tag 必须 `npm stage reject` 后重新暂存。
- 暂存版本在 `npm view` 中不可见，只有 approve 之后才出现在正式版本列表。
- 脚本会在 `--stage` 前校验 npm ≥ 11.15.0、Node ≥ 22.14.0，并用 `--json` 解析 `npm stage publish` 的输出；若 npm 未返回 stage id，会回退到 `npm stage list` 唯一定位，定位不到则提示改用 `stages` 查看。

脚本不会执行 Git commit、tag、push、rebase、自动 unpublish 或 npm 版本覆盖。缺陷修复应递增 patch 版本；发布涉及源码提交，`pack` 与 `publish` 之间不要新增提交，否则 source commit 校验会失败。

## 4. npm 暂存（staged publish）冲突排障

暂存区与正式版本共用同一个 semver 唯一索引，因此会出现两类假象：

- 同一 `包名@版本号` 已被 staged 时，任何再次提交（`npm publish` 或 `npm stage publish`）都会被 registry 以 `E409 Cannot publish over previously staged version` 拒绝，即使本地 tarball 已重新构建。
- **暂存版本在 `npm view` 中不存在**。只差 approve 时，脚本的可见性等待会一直 404，看起来像发布没生效。

遇到这种情况先查暂存状态，不要递增版本号重试：

```bash
node scripts/k-release.mjs stages
```

该命令列出两个发布包的暂存条目（stage id、版本、tag、时间、提交者）。建议先用 `npm stage view <stage-id>` / `npm stage download <stage-id>` 核对内容，确认就是本次构建后批准：

```bash
node scripts/k-release.mjs stage-approve \
  --stage-id <stage-id> \
  --version 1.0.40 \
  --otp 123456
```

`stage-approve` 会调用 `npm stage approve <stage-id>`，并在给出 `--version` 时等待 registry 返回该版本。批准前请核对 stage 条目的 shasum 与 `artifacts/k-release-<version>.pack.json` 中的 tarball 一致，避免发布其它机器或流水线暂存的内容。

暂存内容不是本次构建时丢弃它，再重新发布：

```bash
npm stage list k-vtable
npm stage reject <stage-id>
node scripts/k-release.mjs publish --version 1.0.40 --tag latest --package k-vtable
```

publish 自身也会处理该冲突：`npm publish` 返回 `E409` 时会重试一次，每次先确认 registry 是否已经出现相同 integrity 的版本（避免把真实成功误报为失败）；仍被拒绝时会列出相关暂存条目并给出 approve/reject 指引，而不是抛出裸栈。命令开始前若发现目标版本已发布：integrity 与本地一致则按成功处理并只刷新状态文件，不一致则直接失败并提示改用新的 patch 版本。

## 常见失败

### `CanvasFactory is not configured`

检查 pack 输出中的依赖图。`@visactor/vrender`、core、kits、components 和 animate 必须全部只有 1.1.5。不要通过在 React bundler 中内嵌另一份 VTable 来规避依赖问题。

### prepare 找不到源码版本

构建产物已过期，或上游改变了版本注入格式。重新执行不带 `--skip-build` 的 prepare；不要手工无约束替换构建文件。

### 找不到 Chrome

安装 Chrome/Chromium/Edge 后重新执行 pack。浏览器门禁用于复现 VRender 全局注册冲突，不能用仅 Node 的测试替代。

### `E409 Cannot publish over previously staged version`

见「[npm 暂存（staged publish）冲突排障](#4-npm-暂存staged-publish冲突排障)」。用 `stages` 查询、`stage-approve` 批准或 `npm stage reject` 丢弃后重发；不要通过覆盖已发布版本或递增版本号绕过。

### `EPERM` / `EACCES` 读写 `~/.npm`

缓存或日志目录属主不对（例如曾被 root 运行过）时，`npm view`、`npm whoami` 等命令会直接以 `EPERM` 失败，而不是返回 404。脚本会把这类错误标记为环境故障并提示修复，不会误判成「版本未发布」。常见修复：

```bash
ls -ld ~/.npm ~/.npm/_cacache ~/.npm/_logs
sudo chown -R "$(id -u):$(id -g)" ~/.npm
```

### `ENEEDAUTH` / `E401` / `EOTP`

`ENEEDAUTH`、`E401` 表示当前终端未登录目标 registry，先 `npm login` 或配置 token；`EOTP` 表示需要 2FA，请在交互终端重试或追加 `--otp <code>`。脚本会在错误信息中区分这三类提示。

### 核心已发布、React 失败

保留原 `artifacts/k-release-<version>.pack.json` 和两个 tarball，修复登录或 registry 问题后单独重跑失败的那一条：

```bash
node scripts/k-release.mjs publish --version 1.0.40 --tag latest --package k-react-vtable
```

已成功发布的包会按其 `k-release-<version>-<package>.published.json` 与 registry integrity 判定，重复执行只刷新状态文件；若核心 integrity 与本地不一致，停止发布并使用新的 patch 版本。
