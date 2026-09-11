# 手机门户 · 技术文档（给 Agent 的速览）

> 目标：让任何**新接手 agent / 开发者**在 10 分钟内理解这个项目如何运转、如何扩展、有哪些坑。
> 请在改代码前先读完"关键不变量"和"坑与经验"两节 —— 它们记录的都是在构建过程中真实踩过的坑。
> 📋 **硬规则**：任何值得落地的技术与设计决策、以及变更，都必须同步写进文档——见根 [AGENTS.md](../AGENTS.md)；每个子应用维护自己的 `apps/<id>/README.md`。不写文档的改动视为未完成。

---

## 0. TL;DR

- 这是一个跑在**手机 / Termux 本机**的**门户网站**，前后端**都用 TypeScript**。
- 门户由若干个**彼此独立的子应用**组成。每个子应用是一个完整的小网站（HTML/CSS/TS）。
- 后端 = Node 原生 `http`，**零运行时依赖**；前端 = 浏览器原生 ESM，**无打包器**。
- 构建只有一步：`tsc` 编译 TS + 拷贝静态资源到 `dist/`（即 web 根）。
- 子应用通过 `apps/<id>/manifest.json` **自动注册**，加/删子应用**不需要改服务端代码**。
- 门户主页渲染子应用卡片，点击后在同一**同源 iframe** 中打开该子应用（相互隔离）。
- **设置持久化在服务器**：`GET/PUT /api/settings/:scope` → `data/settings.json`（`dist/` 之外，构建不会清掉）；子应用内容（如笔记正文）仍可用 `localStorage`。

---

## 1. 定位与约束

- **本地优先**：服务运行在手机 Termux 上，默认绑定 `0.0.0.0:3000`，同网段其它设备可通过 `http://<手机IP>:3000` 访问。
- **轻量**：为了在手机环境稳定运行，后端刻意**不引入任何运行时 npm 依赖**（只用 `node:*` 内置模块）。
- **可扩展的"微前端"思想**：子应用完全不依赖门户框架，只要放进 `apps/` 并提供 manifest 即可被门户发现、承载。
- **无框架、无打包器**：前端用浏览器原生 ESM + CSS 变量；唯一的构建工具是 `tsc`。

---

## 2. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 语言 | TypeScript 5.8 | 单一仓库，单一 `tsconfig` 全量编译 |
| 后端 | Node 26 + `node:http` | 零运行时依赖；路由 + 静态服务 + JSON API |
| 前端 | 原生 ESM（`<script type="module"`>）+ 原生 CSS | 无框架、无打包器 |
| 构建 | `scripts/build.mjs` | 调 `tsc` + 拷贝静态资源 |
| 持久化 | 服务器 `data/settings.json`（设置）+ 浏览器 `localStorage`（应用内容） | 设置必须经 `/api/settings/:scope` 落盘到服务器（跨重装/跨设备保留，服务器可见）；应用内容按应用隔离用 localStorage |

**模块系统**：`"type": "module"`（ESM）。`tsconfig` 使用 `"module": "NodeNext"` / `"moduleResolution": "NodeNext"`。

---

## 3. 目录结构与文件职责

    portal/
    ├─ package.json              # 脚本: build / start / dev / launch；devDeps 仅 typescript + @types/node
    ├─ tsconfig.json             # 全量编译配置（rootDir="." outDir="dist"，include 4 处源码）
    ├─ data/                     # ★ 运行时用户数据（不在 dist/ 内、已 gitignore）
    │  └─ settings.json          # 设置存储：{ "<scope>": <JSON 对象> }，由 /api/settings 读写
    ├─ scripts/
    │  ├─ build.mjs              # 构建入口：tsc 到 dist.next/ → 拷静态资源 → 原子换入 dist/
    │  ├─ dev-serve.mjs          # dev 监督者（= npm run dev）：轮询源码签名 → 重建 → 重启服务器子进程
    │  ├─ verify-stick.mjs       # 摇杆/相机/设置（含环境光与相机偏航）的 CPU 侧验证（几何不变量 + 默认值 + 钳制 + 稀疏覆盖 + **偏航轨道/基/屏幕→世界映射** + **视角输入（锚点/灵敏度/±180 回绕/右推=右转）+ 落点即原点 + 固定行程 + 横轴锁 + 视角区尺寸 + 开火键位置**）
    │  ├─ verify-panel.mjs       # 设置面板 DOM 接线的 CPU 侧验证（DOM shim：**满屏分页结构**（固定头/固定页签/唯一滚动体、✕ 在头部第一个、六页六签/切页、隐藏页仍生效、操控页两列）/15 个滑块/八个回调/组级重置 + **开火键拖拽放置 + 视角区显形开关 + 真实 `Input` 的「偏心按下不跳变」端到端回归** + `bindFireButton`）+ **styles.css 的源码级结构断言**
    │  ├─ verify-fog.mjs         # 射击子应用的高度雾：着色器补丁的锚点/注入位置/世界坐标公式（对照 vendor 的 three）+ **世界观感的显示空间包裹（注入点在 `colorspace_fragment` 左边、手写 sRGB EOTF 与 three 的 `sRGBTransferOETF` 往返 < 1/255）** + 雾公式的纯数学 + 「受光材质只有一个构造点」的源码级不变量
    │  ├─ verify-tone.mjs        # 射击子应用的画面调性：调色板模型（光照→toon→雾→调色→sRGB）与 CIE Lab/ΔE 度量、分级的恒等/乘性/冷暖/对比/饱和、**显示空间算子的定义域（超白输入必须被折进 0–1；旧算法在同一输入上确实发绿，留作回归断言）+ 瞬时光源色相（枪口/弹丸/爆炸 × 距离 × 入射角 × 调性）**、暗角卡片几何（用 vendor three 投影四角）、**世界观感的组装顺序（声明 < 编码 < 雾 < 调性 < 解码 < `colorspace_fragment`，且顺序只写在一处）**
    │  ├─ verify-postfx.mjs      # 射击子应用的像素化后处理 + 正交相机：块/target 的设备像素换算、**相机对齐的稳定性（用 vendor three 的真投影断言亚像素余数不变）**、**离屏 target 的合成色彩空间（display-referred：全局覆盖输出 chunk、blit 纯拷贝、背景色喂显示字节；断言与直画路径逐位一致）**、后坐力的相机接线、shader 与 renderer 接线的源码级不变量、正交取景与阴影覆盖、**横竖屏像素密度等价性（同一 `heightScale` 下世界/CSSpx 逐位相同、旋转不改变渲染 texel 数、`像素化 = 1` 在 2x 画布上是半分辨率渲染且 DPR 上限不参与；per-orientation 覆盖与 336–920px 之外的 camZoom 钳制这两条破坏路径按实测值钉住）**
    │  ├─ verify-burn.mjs        # 燃烧 DoT + 粒子特效的 CPU 侧验证（跳点表/叠层独立/帧率无关/火焰/六层爆炸/**爆炸火光（峰值在第 1 帧、按 S 缩放、跟着火球衰减、单调、寿命后排空、不产生粒子）**/朝向数学）
    │  ├─ verify-ammo.mjs        # 弹夹/自动换弹 + 冲锋枪 + HUD 读数（三参数可配置 / 换弹时序 / 帧率无关 / 散布 / 曳光弹速度）+ **后坐力（每武器数值与排序 / 方向 / 衰减 / 脏数据 / 瞄准不变）**
    │  ├─ verify-melee.mjs       # 近战 180° 伤害锥 + 挥砍新月/气流/冲击环的 CPU 侧验证（快→慢曲线 + 跟随锚点 + 扫掠数学 + 几何包络 + yaw 约定 + 方向交替）
    │  ├─ verify-muzzle.mjs      # 枪口特效：三把远程武器的分层配方（层数/粒子预算/色板）+ 六个物理预设与既有 CONFIG 常数逐字段同源 + **`最长寿命 < cadence` 的「一闪而过」不变量** + 单发实测（与首颗弹丸出生点逐位同点、方向 = 瞄准方向、齐射只出一次、层拆分一致、枪口高度）+ 冲锋枪星芒的分布（200 发/覆盖锥角/生成瞬间在 ±cone 内/连发不累积）+ RPG 的等角环与向后爆燃 + 生命周期与脏定义 no-op + 瞬时光源系统（上限/构造器闸门/衰减曲线、枪口与爆炸共用一条扁平列表）+ 渲染接管线的源码级断言（同一个 8 盏点光池、新的优先、渲染层不认识配方）
    │  ├─ verify-cover.mjs       # 掩体：布局不变量（净空/不重叠/无死区）+ 圆-AABB 解算/滑行 + 线段-AABB + 子弹/近战/火箭溅射被挡
    │  ├─ verify-gunner.mjs      # 枪手 AI：三档走位/原地站定/视线门控/**预警→连发一梭子→换弹时序（发数 = 武器弹夹、梭内间隔 = 武器射速、梭间 = 换弹 + 预警）**/**武器复用（CONFIG 不再自带射速与散布的负断言）**/弹伤玩家与无敌帧/环形生成与兵种配比
    │  ├─ verify-vision.mjs      # 玩家视野：可见多边形 vs lineBlocked 的网格交叉验证 + 门控公平性（无隐形枪手/无盲击）+ 自动瞄准只锁可见敌人 + **开火辅助的 15° 锥（含 2 秒棘轮反向断言与停火回正）** + 变暗叠加面几何光栅化
    │  ├─ verify-props.mjs       # 场景美术：道具目录 vs 磁盘 .glb 实测尺寸（节点变换 + 还原居中，防改名/防手抄错）+ 掩体道具不越出碰撞脚印 + 逐掩体覆盖率/高度/件数下限 + 房间无缝 + 点缀 keep-out + 同种子可复现 + 主题覆盖色
    │  ├─ verify-shadow.mjs      # 主光阴影盒：与 vendor three 的 shadow 矩阵逐点一致 + 视野覆盖 + texel 吸附（不蠕动）+ 真实几何光栅化出的 PCF-soft 采样（空白探针的 acne 曲线、逐帧翻转率、覆盖缺失）+ **偏航（基与真实 lookAt 相机一致、9 个角度覆盖率仍 100%、yaw=0 逐位复现旧拟合）**
    │  ├─ lib/glb.mjs            # 共享 .glb 读取器（应用节点 TRS + 与 assets.ts 相同的居中）：verify-props 量尺寸、verify-shadow 拿三角形
    │  ├─ verify-zoom-lock.mjs   # 外壳的页面缩放锁（顶层 viewport meta + html/.appframe 的 touch-action + iOS gesturestart + dist/ 产物同步）
    │  ├─ verify-spawn-cost.mjs  # 射击子应用**每只敌人的动画预算**（真机「突然卡半秒」的根因）：按 `characters.ts` 清单对两个角色分别读回 clip/轨道数，断言播种时 `clipAction()` 为 0、每个状态名都存在且各只建一个动作、`dispose()` 解绑、常驻堆（骷髅时代 1.79MB → 现在 0.06–0.09MB，`--expose-gc` 才有堆断言）
    │  ├─ verify-characters.mjs   # 射击子应用**角色模型**（按 `characters.ts` 清单，逐角色）：自包含无外链 + 每个 skin 共用同一组骨骼 + 静止朝向 +Z（人形看脚尖/脚踝，机器人看眼睛/身体）+ 映射的 clip 全在 + 瞄准片段覆盖 ≥10/13 上半身骨骼 + `strip` 网格确实被剥掉（含「不剥身体就会偏 0.66」的反向断言）+ 归一化 2.0 高/身体居中 + **「头骨在身高里的位置」> 72%**（Q 版回归门）
    │  ├─ verify-character-render.mjs # 射击子应用**着色器空间**的角色验证：按 GLTFLoader 的方式重建场景（网格节点即 SkinnedMesh、单位阵绑定）后走真实 `spawnFromTemplate`，用 `applyBoneTransform × matrixWorld` 量「画出来多大」「有没有巨大网格」「**描边外壳的世界厚度 ≈ OUTLINE_WIDTH**」——真机「每个人都是巨大黑球」的回归门（Box3 类断言看不见着色器里的偏移）
    │  ├─ preview-model.mjs      # **离线模型预览**（本环境无浏览器）：把任意 .glb/.gltf 的四个正交视图光栅化成一张 PNG（零依赖自写 PNG + 平面着色，绑定姿势、不做蒙皮），用来在换模型前真的看一眼形状/朝向/手持物
    │  ├─ verify-fbx2glb.mjs    # FBX→GLB 子应用（apps/fbx2glb）：**用真样例跑真管线**——vendored FBXLoader 解析（蒙皮/骨骼/两个 take）→ 合并（挑本体/骨架漂移重定向/覆盖率门跳过）→ GLTFExporter 写出 GLB → 容器断言（magic/长度/对齐/单一 buffer/无 uri/通道指向关节）→ **GLTFLoader 读回自检** → 缩放只发生一次（含 `readGlb`/`writeGlb` 往返与「缩放不改 BIN」）→ 命名/单位/骨架匹配/设置 schema 的纯规则 → **「不上传」源码级断言**（无 localStorage/XHR/FormData、唯一 fetch 只取内置样例）→ **DOM shim 启动真实 main.js 走一遍用户流程**（样例→转换→下载不联网→改设置只发一次 PUT→多文件/合并两种模式→恢复默认真的落盘）
    │  ├─ verify-diag.mjs        # 射击子应用**卡顿归因**（`?diag=1`）：`diagcore.ts` 的七条规则与正反用例（编译同时掉堆必须报编译 / 长帧但 JS 便宜不许算到 sim / 无 `performance.memory` 就不给 GC 归因）+ 有界日志与分位 + 用 DOM shim 和假时钟/假堆驱动真实 `diag.ts` 的帧记账、读数、点按面板、`report()`/`json()`、**分辨率链（`postfx.ts::resolutionChain/resolutionText`：两个方向的 texel 数相同、相机高度差出 13.8 vs 18.7 px/世界单位、`像素化 = 0` 时改吃画布与 DPR、脏数据不印 NaN，以及 badge 第二行 / 面板两行 / `json().resolution` 的接线与「provider 抛错静默留空」）**
    │  └─ trace-shooter.mjs      # 子应用回归工具：固定 PRNG 跑脚本化场景，逐帧打印射击模拟状态（重构前后 diff 必须为空）
    ├─ server/                   # 后端（Node + TS，编译到 dist/server/src/*.js）
    │  └─ src/
    │     ├─ index.ts            # HTTP 服务器：路由、静态服务、API、MIME、防路径穿越、请求体读取
    │     ├─ registry.ts         # 扫描 apps/*/manifest.json 生成注册表；PORTAL 元信息；ROOT 常量
    │     └─ settings.ts         # 设置存储：读写 data/settings.json（原子写 + 串行队列 + 结构校验）
    ├─ shell/                    # 门户外壳（前端；编译到 dist/shell/*.js）
    │  ├─ index.html             # 门户主页（引用 /shell/styles.css 与 /shell/main.js）
    │  ├─ styles.css             # 门户样式（移动优先、深色、CSS 变量、safe-area）
    │  └─ main.ts                # 拉取 /api/manifest → 渲染卡片网格；哈希路由；iframe 承载子应用
    ├─ shared/                   # 前后端共享（编译到 dist/shared/src/*.js）
    │  └─ src/
    │     ├─ types.ts            # SubAppManifest / PortalManifest / normalizeManifest / DEFAULT_COLOR
    │     └─ settings.ts         # 设置 API 的浏览器侧封装：loadSettings / saveSettings（永不抛错）
    └─ apps/                     # 子应用目录（每个子应用 = 一个独立网站）
       ├─ notes/                 # 📝 我的笔记（localStorage：笔记正文属于「应用内容」）
       ├─ clock/                 # ⏰ 时钟 + 秒表
       ├─ calculator/            # 🧮 计算器（内置表达式解析，无 eval）
       ├─ blackhole/             # 🕳️ 黑洞（WebGL2 Schwarzschild 光线追踪 + 吸积盘）
       ├─ fbx2glb/               # 🧊 FBX → GLB 转换器（浏览器内转换：vendored three r160 的 FBXLoader + GLTFExporter + GLTFLoader，把多个 Mixamo 动作文件合并成一个自带全套 clip 的角色文件；自动挑角色本体 + 骨架名重定向 + 占位 take 名处理 + 实测高度自动厘米→米 + 导出后读回自检 + WebGL 预览；**文件不上传**；设置两组，见 apps/fbx2glb/README.md）
       └─ shooter/               # 🎯 射击竞技场（Three.js 室内 76×76 掩体射击 PvE + Kenney 室内道具（CC0，49 个 .glb/541KB）+ 枪手 AI（复用 `weapons.ts`：预警 0.5s → 打空一梭子 → 换弹）+ 20 块掩体 + 视野遮挡（隐藏/变暗）+ 弹夹/自动换弹 + 背包与物品槽位（20 格 + 主/副武器/投掷/治疗/护甲）+ 备弹（单格 200）+ 护甲穿透（穿甲 0–6 驱动默认公式：甲伤 ×0.7/级、肉伤 100/75/50/0%；**每弹药可按护甲等级覆写甲伤/肉伤表**，样板龙息弹 = Lv4 显示 / 穿甲 0 / 1–4 级甲 100% 甲伤；敌人按波次配甲、六色等级标识）+ 4 把武器 + **满屏分页设置面板（六页：操控/画面/视野/光照/雾/后期；画面含相机高度与水平角度）**，见 apps/shooter/README.md）

**子应用目录内部**（`apps/<id>/`）：

    apps/<id>/
    ├─ manifest.json   # 注册信息（门户依赖它自动发现；唯一"必须"字段）
    ├─ index.html      # 应用入口页（引用 ./styles.css 与 ./main.js）
    ├─ styles.css      # 应用样式
    └─ main.ts         # 应用逻辑（被 tsc 编译为 ./main.js）

### 入库边界（`.gitignore`）

仓库只提交**源码、静态资源与验证脚本**。以下内容刻意不入库（原因同时写在 `.gitignore` 注释里）：

| 排除项 | 为什么 | 丢了怎么办 |
| --- | --- | --- |
| `node_modules/` | 只有两个 devDependency，可重建 | `npm install` |
| `dist/`、`dist.next/` | 构建产物，且构建会整体替换 `dist/` | `npm run build` / `npm run dev` |
| `data/` | **运行时用户数据**（设置存储）。构建会 `rm dist` + rename，放进 `dist/` 必然丢；而它本身是用户真实设置，不属于源码 | 用户设置回落到代码默认值 |
| `/*-preview.png`（**仅根目录**） | `scripts/preview-model.mjs` 的中间产物，挑模型时看一眼，随时可重跑 | 重跑 `preview-model.mjs` |
| `*.log`、`.env` | 日志与本地机密 | — |

> ⚠️ **坑（真实踩过）**：预览图的忽略规则**必须锚定根目录**（`/*-preview.png`），不能写成 `*-preview.png`。后者会连 `docs/blackhole-preview.png` 一起排除掉——那是下面第 10 节引用的**验证证据**，属于文档资产，必须入库。判断标准是「**能不能重跑出来**」+「**文档是否引用它**」，两条都满足才排除。

---

## 4. 请求生命周期（后端）

服务器 `server/src/index.ts` 用 `node:http` 创建 `http.createServer`，对每个请求按顺序匹配：

| 优先级 | 路由 / 路径 | 行为 |
|---|---|---|
| 1 | `GET /api/manifest` | 返回 `{ portal, apps[] }`（每次实时扫描 `apps/`） |
| 2 | `GET /api/apps/<id>` | 返回单个子应用 manifest；不存在则 404 |
| 3 | `GET /api/portal` | 返回门户元信息 + 当前应用总数 |
| 4 | `GET /api/settings` | 返回整个设置存储 `{ "<scope>": value }`；其它方法 405 |
| 5 | `GET /api/settings/<scope>` | 返回 `{ scope, value }`；未存过 `value: null`；scope 非法 400 |
| 6 | `PUT /api/settings/<scope>` | 读 body（≤8KB）→ JSON 解析 → 结构校验 → 原子写盘 → `{ scope, value }`；其它方法 405 |
| 7 | `GET /` 或 `/index.html` | 服务 `dist/shell/index.html`（门户主页） |
| 8 | 其它静态路径 | 从 `dist/` 之下按文件服务（shell/apps/shared 的资源都在这） |
| 兜底 | 未命中 | 404 |

**静态服务关键点**（`serveFile`）：
- 用 `path.resolve` + `startsWith(root + sep)` 做**路径穿越防护**。
- 命中目录时自动回退到其 `index.html`。
- 通过 `MIME` 映射设置 `Content-Type`。
- 所有响应 `Cache-Control: no-cache`。

**设置持久化（`server/src/settings.ts` + `shared/src/settings.ts`）**

- **存储位置 `data/settings.json`（`ROOT/data`，`ROOT` 由 `registry.ts` 从 `import.meta.url` 推导，与 cwd 无关）**。**不能放 `dist/`**：构建会整体换掉 `dist/`，用户设置每次保存都会丢。`data/` 已 gitignore，也**不在 dev 轮询的扫描范围内**（否则每次保存设置都会触发一轮重建 + 重启）。
- **文件格式**：一个扁平 map，键是 scope（通常 = 子应用 id），值是任意 JSON 对象；scope 名必须匹配 `/^[a-z0-9][a-z0-9._-]{0,31}$/i`。示例：
      { "shooter": { "stick": { "landscape": { "sizePx": 96 } } } }
- **PUT 语义 = 整 scope 替换**（不是深合并），客户端负责提交自己完整的状态；服务端**不校验业务 schema**，只校验「是 JSON 对象 + 键名合法 + 体积 ≤ 8KB + 嵌套 ≤ 6 层 + 数值有限 + 无 `__proto__`/`constructor`/`prototype`」。业务 schema 由各应用的 `settings.ts` 负责（读脏数据要钳制/丢弃，不能抛错）。
- **原子写 + 串行队列**：先写 `settings.json.tmp` 再 `rename()`，读方只会看到旧的完整文件或新的完整文件，不会读到半截 JSON；所有写操作串在一条 Promise 链上，避免两个 PUT 交叉读改写导致丢更新。
- **降级**：文件缺失 → `{}`；文件损坏/不是 JSON 对象 → `console.warn` + 当 `{}`（不崩、也不自动覆盖用户文件）。
- **客户端封装**：`shared/src/settings.ts` 的 `loadSettings(scope)` / `saveSettings(scope, value)` 永不抛错，失败返回 `{ ok:false, error }`；子应用用相对路径导入（见第 6 节）。失败时应用必须继续用本地默认值/本地值运行，只把「保存失败」显示出来。
- **用户数据不进 web 根**：`data/` 不在 `dist/` 之下，所以 `GET /data/settings.json` 是 404（已实测）。

**启动即发现**：`registry.ts` 的 `loadRegistry()` 每次被调用时读取 `apps/*/manifest.json`，用 `normalizeManifest` 补全字段并按 `order` / `name` 排序。所以**无需缓存、无需重启**即可反映 `apps/` 的最新结构。

---

## 5. 构建管线（`scripts/build.mjs`，原子构建）

每次 `npm run build` 做三件事：

1. **编译到 `dist.next/`**：`node node_modules/typescript/lib/tsc.js -p tsconfig.json --outDir <abs>/dist.next`。
   - `tsconfig` 的 `rootDir="."`，因此 **源代码树结构被保留映射**：
     - `server/src/index.ts` → `<out>/server/src/index.js`
     - `shell/main.ts` → `<out>/shell/main.js`
     - `apps/notes/main.ts` → `<out>/apps/notes/main.js`
2. **拷贝静态资源**：遍历 `shell/`、`apps/`、`shared/`，把**所有非 `.ts` 文件**（html/css/json/图标/svg 等）原样拷到 `dist.next/` 对应相对路径，跳过 `node_modules`/`.git`/`.DS_Store`。
3. **原子换入**：`rmSync(dist)` + `renameSync(dist.next, dist)`（同一文件系统上的 rename 是原子的）。

> `dist/` 就是 web 根：服务器只从 `dist/` 读文件。

**为什么必须是原子的**：旧实现是「先 `rm dist` 再 `tsc`」，一旦 tsc 报错，被服务的目录就空了——**一个拼写错误就能让线上 404**（静态文件是按请求读盘的）。现在编译进 `dist.next/` 再换入，**构建失败时 `dist/` 与正在运行的服务器都不受影响**，`npm run dev` 可以一边报错一边继续服务。`dist.next/` 永远不被服务器读取（它是 `dist/` 的兄弟目录），已在 `.gitignore` 里。

### dev 监听（`npm run dev`）

`package.json` 的 `dev` 脚本 = `node scripts/dev-serve.mjs`：**自带轮询扫描器**（每 `DEV_POLL_MS`（默认 800ms）递归 stat `server/ apps/ shell/ shared/ scripts/`，比对 `路径 → mtimeMs:size` 签名），发现差异即「先重建、成功后再重启服务器」。

- **为什么是轮询而不是 `fs.watch`**：本机（Termux/Android）的 `fs.watch({recursive:true})` 会**静默停止投递事件** —— 监督者进程还在、`/proc/<pid>/fdinfo` 里 inotify watch 仍在（实测 70 个活跃 watch）、进程停在 `do_epoll_wait`，但 `touch` 任何源码都不再触发重建。真实踩过两次（第二次已经用数组持有 FSWatcher 引用，排除了 GC 因素），表现为「我改了代码怎么没生效」。单跑一个递归 watcher 做 80s 压测却一直正常，所以这是难以定位的平台/Node 交互，不值得依赖。源码树只有 ~54 个文件，800ms 一轮 = 每秒几十次 stat，代价可忽略，而且**判定逻辑在自己的代码里**，可测、可解释。
- **忽略规则**：隐藏文件/目录（编辑器临时文件，例如 DSH 编辑工具写的 `.<name>.<pid>.<uuid>.tmpdir`、`.DS_Store`）、`node_modules/ dist/ dist.next/`、`*~`、`*.swp|swx|tmp|tmpdir`。**真实踩过**：不过滤这些，每次保存都会多触发 2–3 次「重建 + 重启」（一次 3–4 秒）。
- **轮询也覆盖新增/删除/改名**（签名里多出的键或消失的键都会触发），比递归 watcher 的删除上报更可靠。
- **顺序很关键**：先 build（原子换入），成功后才 `SIGTERM` 旧子进程并 `spawn` 新的。构建失败就**保持旧服务器继续跑**，不会把站点打成 404。
- **`scripts/` 也在扫描范围内**：`build.mjs` 每次构建都是新起的子进程，所以它的改动立即生效；但**监督者自己的代码已经加载**，改 `dev-serve.mjs` 只会触发一次重建 + 服务器重启并打印提示，需要手动重启 `npm run dev` 才会重载监督者。
- `dev-serve.mjs` 收到 SIGTERM/SIGINT 时先杀子进程（1.5s 后升级 SIGKILL）再退出，避免端口未释放导致 `EADDRINUSE`。
- **不要改回 `fs.watch`**，也不要用 `node --watch`：① Node 文档写明 `--watch-path` 只在 macOS/Windows 支持；② `node --watch` 重启的是**监督者自身**，每次保存都要重跑一遍 build 并重新 spawn，顺序不受我们控制；③ **绝不能监听 `dist/`**：构建会替换它，监听者会看到自己 import 的文件消失而报 `MODULE_NOT_FOUND`。服务器一律以子进程 `spawn`（不 `import` dist 文件）。
- **注意**：`npm start` 启动的是**普通进程**，改完源码必须重启（见第 10 节）。日常开发一律用 `npm run dev`。

---

## 6. 模块系统与导入约定（重要）

- 项目是 **ESM**（`"type": "module"`）。
- `tsconfig` 用 `NodeNext`，因此 **TS 源码里所有相对导入都必须带 `.js` 扩展名**（写成 `./registry.js`、`../shared/src/types.js`），编译产物才能在 Node ESM 下正确解析。
- **跨仓库共享类型**用 `import type`，可在编译期被完全擦除，浏览器端不会真的去加载它。示例（`shell/main.ts`）：

    import type { PortalManifest, SubAppManifest } from "../shared/src/types.js";

- 前端模块应保持**自包含**（单文件 `main.ts`，不互相 import），以彻底规避浏览器 ESM 的解析复杂度；要共享类型就只 `import type`。
- **例外：确实需要共享的运行时代码放 `shared/`**（目前只有 `shared/src/settings.ts`）。因为 `rootDir="."` 保留了源码树，**源码目录层级与 URL 层级一致**，所以同一个相对路径在 tsc 和浏览器里都成立：
  - `shell/main.ts` → `../shared/src/types.js` = `/shared/src/types.js`
  - `apps/shooter/src/settingsPanel.ts` → `../../../shared/src/settings.js` = `/shared/src/settings.js`

  写错层级会得到 `TS2307`（tsc）或浏览器 404（`node --check` 查不出来，必须 `curl` 验产物）。
- 服务端源码之间的运行时导入（`index.ts` ↔ `registry.ts`）请都写 `.js` 后缀。

---

## 7. 门户外壳与前端路由（`shell/main.ts`）

- 加载后 `fetch("/api/manifest")`，得到 `apps[]`。
- **哈希路由**：`#/` → 主页卡片网格；`#/app/<id>` → 打开某子应用。用 `hashchange` 监听。
- **主页卡片**：每个卡片是一张 `article.card`，带 `data-id`，点击设置 `location.hash` 为 `#/app/<id>`。
- **子应用承载**：`renderApp(id)` 生成一个全屏 `<iframe class="appframe">`，`src` 指向 `app.entry`（默认 `/apps/<id>/`）；顶部有"返回"按钮和"新标签页 ↗"链接。
- **同源优势**：子应用与门户由同一服务器提供（同 host:port），所以 iframe 加载**不受跨域限制**，天然隔离。
- **横屏（`orientation` 字段）**：子应用声明 `"orientation": "landscape"` 时，`renderApp()` 在 appbar 里多渲染一个「横屏」按钮。点击后外壳（= **顶层文档**）执行 `document.documentElement.requestFullscreen()` → `screen.orientation.lock("landscape")`，按钮变为「退出横屏」；点「返回」/离开该路由、或用户用系统手势退出全屏（监听 `fullscreenchange`）时 `unlock()` + `exitFullscreen()`。
  - **为什么放在外壳而不是子应用**：`lock()` 只对**顶层文档**生效，而子应用跑在 iframe 里；而且它要求文档处于全屏，全屏又必须由用户手势触发 —— 所以只能是一个按钮，不能自动执行。
  - **浏览器支持**：Chrome/Edge（Android）可用；**iOS Safari 与 Firefox 没有实现 `lock()`**，此时按钮渲染为 `disabled` 并带 `title` 说明。桌面浏览器大多也不支持（或只在全屏下支持）。
  - **TypeScript 坑**：本项目 `lib.dom.d.ts` 声明了 `ScreenOrientation.unlock()` 却**没有** `lock()`，所以 `shell/main.ts` 里用一个 `interface OrientationLockApi extends ScreenOrientation` 补上这一个方法，而不是到处 `as any`。
  - **横屏下的顶栏**：进入「横屏锁定」后，`<body>` 会带上 `landscape-locked` 类，CSS 直接**隐藏整个 appbar**（横屏视口只有 ~400px 高，顶栏即使压到 34px 也要吃掉 ~8%），同时显示一个**顶部居中的半透明小胶囊**「退出横屏」作为唯一出口。它的定位是刻意的：顶部中间在游戏里是空的（血条上限 28% 靠左、得分/FPS 靠右），且很小、opacity 0.62，不容易在搓摇杆时误触。点击它 → `unlock()` + `exitFullscreen()` → appbar 恢复。
  - 没有锁定横屏时（用户自己把手机横过来）appbar **照常显示**，因为那时「退出横屏」没有意义、用户还需要「返回」。
- **页面缩放锁（双击放大 / 双指缩放）**：外壳是**顶层文档**，所以缩放只能在这里堵 —— `shell/index.html` 的 viewport 带 `maximum-scale=1, user-scalable=no`，`styles.css` 有 `html{touch-action:manipulation}` 与 `.appframe{touch-action:none}`，`main.ts` 里另有 `gesturestart` 兜底（iOS Safari 从 iOS 10 起忽略 `user-scalable=no`，且子应用内的事件不会冒泡到外壳，所以只能靠顶层这三层）。**为什么子应用自己做不了**：缩放作用在**顶层文档的 visual viewport** 上，而子应用跑在 iframe 里，它自己的 `<meta viewport>` 与 `touch-action` 只约束 iframe 内部（真实反馈：射击游戏全局 `*{touch-action:none}` 也挡不住双击放大）。另外双摇杆的**两指按法本来就很像双指缩放**，所以顺带把误触缩放也一起解决了。**取舍**：整个门户都没有页面缩放了（笔记这类文本应用也失去双指放大）；若将来某应用确实需要，把静态 meta 改成「按路由动态改写 viewport meta」即可。
- **安全转义**：所有动态插入的文本用 `esc()` 转义；卡片强调色经 `attrColor()` 校验为合法 hex。

---

## 8. 子应用契约

### manifest.json 字段（`shared/src/types.ts`）

    {
      "id": "notes",            // 可选，默认取目录名；需 URL 安全
      "name": "我的笔记",        // 卡片名称（必填）
      "description": "本地保存的随手笔记",
      "icon": "📝",             // emoji 或路径
      "color": "#f7a44f",       // 卡片强调色（hex）
      "order": 1,               // 越小越靠前（缺省 10000）
      "version": "1.0.0",
      "entry": "/apps/notes/",  // 可选，默认 /apps/<id>/
      "author": "...",          // 可选
      "sizeKb": 12,             // 可选
      "orientation": "landscape" // 可选："landscape" | "portrait"；外壳据此显示「横屏」按钮
    }

### 运行约束

- 应用页面是**原生 ESM**：`<script type="module" src="./main.js">`。
- 资源引用用**相对路径**（`./styles.css`、`./main.js`），因为入口页可能被 iframe 以 `/apps/<id>/` 打开。
- **门户 SDK 仍然不存在**，子应用不知道也不依赖门户；但**设置**是个例外：需要跨设备/跨重装保留的用户设置必须走 `GET/PUT /api/settings/<id>`（见第 4 节与 AGENTS.md 的「设置与用户数据」），客户端封装在 `shared/src/settings.ts`。子应用**只调这一个 HTTP 接口**，不引入任何门户代码依赖。
- 各子应用的**应用内容**（如笔记正文）仍可用 `localStorage`；「设置」不允许只用 `localStorage`。
- 新增/删除子应用 = 增删 `apps/<id>` 目录，然后 `npm run build`。

---

## 9. 关键不变量（改代码前必读）

1. **服务器只从 `dist/` 读文件**。改源码后必须先 `npm run build`，否则运行的是旧产物。
2. **注册表以 `apps/*/manifest.json`（源码）为准**，与服务无关；静态文件以 `dist/` 为准。
3. **所有相对导入要带 `.js` 后缀**（NodeNext）。
4. **前端保持模块自包含**；共享类型走 `import type`。
5. **子应用必须能被单独打开**（`/<id>/index.html`），门户只是把它 `<iframe>` 起来而已。
6. **零运行时依赖**：新增后端能力优先用 `node:*` 内置模块，别引入运行时 npm 包。
7. **路径穿越防护**不可移除：`serveFile` 的 `path.resolve` + `startsWith` 检查是安全基线。
8. **用户数据（设置）必须存在 `dist/` 之外**（当前是 `data/`）：`dist/` 每次构建被整体替换，放进去的数据会在下一次保存时消失。设置一律经 `/api/settings/:scope` 读写，不用 `localStorage`。

---

## 10. 坑与经验（真实踩过，请留意）

- **在 run_code 环境里，`process.env.PATH` 可能为空**。用 `execSync`/spawn 调外部命令（npm、node、curl）时，务必显式注入 PATH，否则报 `env: 'node': Permission denied`。参考值：
    /data/data/com.termux/files/usr/bin:/usr/bin:/bin:/data/data/com.termux/files/usr/local/bin
- **TypeScript 7（新原生编译器）在 Termux 上会踩平台二进制包缺失的坑**（找不到 `@typescript/typescript-android-arm64`）。本项目固定使用 **TS 5.8**（纯 JS、任意平台可跑）。别把 `typescript` 升到 7。
- **模板字符串生成源码时的转义**：用反引号模板来"生成"另一段含 `$ + {` 的代码字符串时，外层模板会把 `$ + {` 当作插值执行，导致运行时 `ReferenceError`。要输出字面量 `$ + {`，必须写成反斜杠加上 `$ + {`。这是本项目早期真实报错（`PORTAL is not defined`）。
- **相对导入层级易错**：`shell/main.ts` 位于 `shell/`，到 `shared/` 是 `../shared/` 而非 `../../shared/`。写错会导致 `TS2307: Cannot find module`，并连锁带来一堆"隐式 any"。
- **不要监听 `dist/`**：构建会替换 `dist/`，监听者会在文件被替换的瞬间看到自己 import 的东西消失（`node --watch` 会直接报 `MODULE_NOT_FOUND` 卡死）。`npm run dev` 由 `scripts/dev-serve.mjs` **轮询源码签名**（`stat` 比对 + 200ms 防抖），服务器始终是 `spawn` 出来的子进程，详见第 5 节。
- **`execSync` 非零退出会抛异常**，本项目的 `build.mjs` 用 `execFileSync` 在 tsc 报错时也会中止并抛错——先看 `tsc` 的真实诊断再定位，别只盯着构建脚本报错。
- **验证编译产物**可用 `node --check dist/<file>.js` 做纯语法检查（不执行、不依赖 DOM）。
- **`server/src/index.ts` 里 `SHELL_INDEX` 常量目前声明未用**——保留不碍事，但属遗留；若要消除，可直接用 `/shell/index.html` 字符串。
- **`allow` 与 iframe 能力**：`<iframe allow="geolocation; camera; microphone">` 按需开放权限，子应用若用这些能力要在此补充（如 `fullscreen`、`clipboard-write`）。
- **`npm start` 不会自动加载改过的代码**：服务器进程启动时就把 `dist/**/*.js` 载入内存，`npm run build` 只改磁盘文件——**静态资源（html/css/子应用 JS）按请求读盘所以立即生效，但 `server/`、`shared/` 的改动必须重启进程**。**日常开发一律用 `npm run dev`**（watch 模式，保存即重建 + 重启），不要用 `npm start` / `npm run launch` 起服务。真实踩过：给 `normalizeManifest` 加了 `orientation` 字段并 build 后，`/api/manifest` 仍然没有该字段，因为跑着的是启动时加载的旧模块。
- **页面缩放（双击放大 / 双指缩放）只能在顶层文档里堵，子应用的 meta 与 `touch-action` 一律管不到**：缩放改的是**顶层文档的 visual viewport**，而子应用跑在 `<iframe>` 里 —— 它的 `<meta name="viewport" user-scalable=no>` 和 `*{touch-action:none}` 只约束 iframe 自己的布局与手势，浏览器照样会把整个门户页面放大。真实踩过：射击游戏（`apps/shooter`）早已有这两样，真机上双击/双指仍然会放大页面。修法是把它当成**外壳职责**（见第 7 节的「页面缩放锁」）：外壳的 viewport meta + `html{touch-action:manipulation}` + `.appframe{touch-action:none}`，再加 iOS 需要的 `gesturestart` 兜底。**同类的判断**：凡是要影响「整个页面」的东西（方向锁、全屏、缩放、主题色），都必须在顶层文档做，改子应用没有意义 —— 唯一例外是子应用被单独打开（`/apps/<id>/`）时，那时它自己就是顶层文档。
- **屏幕方向锁定（`screen.orientation.lock`）的三个前提**：① 只能由**顶层文档**调用（子应用在 iframe 里，调不到）；② 文档必须处于**全屏**（`requestFullscreen()`）；③ 全屏必须由**用户手势**触发。所以只能做成按钮，不能自动执行。另外 **iOS Safari 与 Firefox 根本没有实现 `lock()`**，必须做能力检测 + 降级（本项目渲染成 disabled 按钮）。
- **用户数据（设置）绝不能放 `dist/`**：`npm run build` 是「`rm dist` + `rename dist.next dist`」，任何写在 `dist/` 里的运行时文件（包括用户上传/保存的数据）都会在下一次构建时消失。本项目统一放 `data/`（`ROOT/data`，已 gitignore）。**验证方式**：PUT 一个设置 → `npm run build`（或让 watcher 重建）→ `curl /api/settings/<scope>` 仍在（已实测）。
- **`data/` 故意不在 dev 轮询范围内**：`dev-serve.mjs` 只扫描 `server/ apps/ shell/ shared/ scripts/`。如果把设置文件放进被监听的目录，每次保存设置都会触发「重建 + 重启服务器」，既慢又会把正在写文件的请求打断。
- **写设置文件必须「原子 + 串行」**：直接 `writeFile` 会让并发读到的半截 JSON 解析失败；两个 PUT 同时 read-modify-write 会丢更新。做法：写 `*.tmp` 再 `rename()`（同文件系统上是原子的），并把所有写操作串在一条 Promise 链上；链上要用 `.catch()` 兜住失败，否则一次写失败会让后续所有写都拒绝。
- **前端全局 `*{touch-action:none}` 会让面板无法滚动（而且只改面板本身不够）**：`apps/shooter/styles.css` 为了摇杆/画布禁掉了默认触摸行为。修法**必须同时覆盖后代元素**：`touch-action` 不继承，而且一次 pan 手势只有在「被触摸的元素 **及其所有祖先**」都允许时才生效 —— 只给 `.settings-panel` 写 `pan-y`、却让 `.set-row`/`span` 继续命中 `*{touch-action:none}`，结果就是**只有点在面板自己的 padding 上才能滚**（真实踩过：真机反馈「设置界面无法滚动」）。正确写法：
      .settings-panel{touch-action:pan-y;overflow-y:auto;overscroll-behavior:contain}
      .settings-panel *{touch-action:pan-y}          /* 后代一起放开 */
      .set-range{touch-action:none}                  /* 滑块要吃掉水平拖动（写在后面，同特异性按顺序胜出） */
  另外给面板加 `-webkit-overflow-scrolling:touch` 才有 iOS 惯性滚动。
- **`<input type=range>` 的 `max` 必须跟随钳制结果**：摇杆尺寸受视口高度限制、内边距受「视口宽 − 尺寸」限制。如果滑块 `max` 写死成配置上限，用户把滑块拖到上限时实际生效值会被钳制，**滑块位置与显示值/实际值不一致**。做法：每次同步都按当前视口与当前尺寸重算每个滑块的 `min/max` 再赋值。
- **本机 `fs.watch({recursive:true})` 会静默失效，所以 `npm run dev` 改用轮询**：真实踩过两次 —— 监督者进程活着、inotify watch 还在（`/proc/<pid>/fdinfo` 里 70 个活跃 watch）、进程停在 `do_epoll_wait`，但 `touch` 任何源码都不再触发重建；第二次已经用数组持有 FSWatcher 引用，所以**不是 GC** 能解释的（单跑一个递归 watcher 做 80s 压测却一直正常）。表现就是「我改了代码怎么没生效」，极易误判成构建缓存或浏览器缓存。现在 `dev-serve.mjs` 每 800ms 递归 `stat` 一遍源码树比对签名（~54 个文件，代价可忽略），并覆盖新增/删除/改名。**排查手法**：`touch` 一个源码文件，看监督者有没有打印 `[dev] change detected`；没有就重启 `npm run dev`。详见第 5 节。
- **行为快照脚本必须打印「真正被更新的那个字段」**：`scripts/trace-shooter.mjs` 一直打印的是 `p.fireTimer`，而攻击计时器其实是 **`sim.fireTimer`**（`GameSim` 的字段）；`Player` 上那个同名字段只在初始化时写一次、之后从不更新，所以快照里这一列**恒为 0**，整套开火节奏（射速改动、卡刀、冷却重置）都从指纹里消失了。已改为 `sim.fireTimer`。教训：**写回归工具时先确认字段归属**（`this.x` vs `p.x`），否则脚本会安静地测一个常量。副作用：改字段会改变快照输出，所以「重构前后 diff 为空」的基准要重新记录一次。
- **持续伤害（DoT）按「结清欠下的跳数」实现，并给时间断言留一帧容差**：燃烧的每一层只存 `endTime`/`nextTick`/`dps`/`period`，每帧用 `while (nextTick <= time)` 把上一帧以来欠下的跳数一次结清——这样总伤害与帧率无关（20fps 与 60fps 实测一致；若只 `if (nextTick <= time) tickOnce()` 则会随帧率丢跳）。**坑**：`this.time += dt` 会累积浮点误差，跳点可能比理论时刻**晚一帧**（实测 3.0167 而非 3.0000），所以断言时间要用 `|t - 理论值| <= dt + ε`，不要用相等比较。另外**同一帧的多层伤害必须合并成一次 `damageEnemy()`**：否则每层各设一次 `hitFlash`，红闪时长会随层数变化；致死的那一次再走 `resolveDeath()`（计分 + 爆裂），死亡时把状态数组清空。
- **构建换目录有一个很短的窗口，验证脚本要等一轮重建结束再跑**：`build.mjs` 是「`rm dist` → `rename dist.next dist`」，所以在换目录的那一瞬间 `dist/` 是不存在的。真实踩过：在 watcher 重建过程中跑 `verify-stick.mjs`，报 `ERR_MODULE_NOT_FOUND: dist/apps/shooter/src/camera.js`——不是代码问题，是撞上了窗口。看到这类「文件突然找不到」先看 `npm run dev` 的输出是不是刚打完一轮，再重跑一次。
- **会被整个替换掉的状态，外部视图必须每次重新取，不能缓存引用**（射击子应用「重新开始之后背包还是旧数据，而且无法拖动」）：`GameSim.reset()` 给每局重建配装（`this.inventory = createInventory()`，**新对象**），而背包面板当初是把它当**值**收下的（`inventory: sim.inventory`）。后果不是"显示旧数据"这么轻：面板的**显示**用死对象、**校验**（`canMove`）也用死对象，而提交（`sim.moveItem()`）改的是新对象——三者不一致，于是合法拖放毫无反应，新背包还可能被"看不见地"改动（显示与真相分叉，这是最难排查的一类状态 bug）。修法是接口层面的：面板只通过 `getInventory: () => sim.inventory` 读模型。**通用规则**：凡是 `reset()`/`load()` 会**替换对象**（而不是原地清空）的状态，跨模块的持有者只有两种安全写法——每次从根对象重新取（getter/方法调用），或者让重建改成原地清空+重填。**注释不算证据**：`reset()` 里那句"每局新背包"从一开始就写着，但没有任何断言钉住它；现在 `verify-inventory` 先用真实 `GameSim` 断言 `reset()` 确实换了对象，再断言面板会跟着换，两边同时被钉住。同类检查项：任何"每局/每次加载重建"的容器（背包、关卡、实体列表）都要问一句"谁还在拿旧的"。
- **`elementFromPoint` 返回的是最内层元素，而"测试替身返回什么"决定了这类 bug 能不能被 CPU 侧发现**（射击子应用背包的拖放，真机反馈「拖到另一个物品上判定不稳，只有一点点区域被判定为拖到」）：拖放的落点判定用 `document.elementFromPoint(x,y)` 再读 `dataset.ref`，而**有物品的格子里那三个文本 span 几乎铺满格子中部**，手指实际压在 span 上 → 读不到 ref → 只有文字四周那圈 padding/border 算命中（空格子的 span 是零尺寸，所以空投一直是好的，现象正好是"拖到物品上才不稳"）。修法：命中后 `closest('[data-ref]')` 向上找归属格子，并给格子的子元素加 `pointer-events:none`（双重保险，且让"格子是唯一交互单元"这条意图写在 CSS 里）。**真正的教训在测试侧**：这一版的 DOM shim `elementFromPoint` 一直返回**格子**，于是"浏览器返回 span"这个世界从未被模拟，测试全绿而真机是坏的——**替身必须模拟最内层命中**（现在 shim 有父链 + `closest()`，回归测试直接把命中点设成目标格的名称 span）。推论：任何"从命中的元素读 data 属性"的代码，都要问一句"如果命中的是它的子元素呢"，以及"我的测试替身会不会恰好掩盖这一点"。
- **"不受光的特效 + 环境光为 0"会把被特效覆盖的物体变成黑洞：让被点燃的东西自己发光**（射击子应用真机反馈「龙息弹外面一圈是红色亮光，中间反而变黑了」）：诊断是一条可以纯代码走完的链——火焰粒子是**不受光的加色四边形**（它们必须保持纯信号色，且要画在雾/分级之前），场景里真正的光源只有两盏方向光 + 上限 8 盏挂在**弹丸**上的点光，**火焰本身不点亮任何东西**；再加上环境光被要求调到 0，被点燃的敌人身体就收不到任何光、本来就是近黑；而它又是不透明几何，把背后的火焰挡住了。结果就是"亮圈 + 黑洞"。**修法不是把特效改成受光**（那会毁掉信号色与门控），而是**让被点燃的物体自发光**：按燃烧层数给角色材质一个自发光着色（`apps/shooter/src/chartint.ts`，纯函数，可 node 断言）。**要点**：① 自发光（three 的 `totalEmissiveRadiance`，加在光照之后）是"无论收到多少光都读得出来"的唯一手段，additive 特效做不到（它只能加在已经渲染出来的像素上，被不透明物体挡住的部分它加不到）；② 这种"按状态着色"的通道与既有的受击红闪**写同样的材质字段**，必须收敛到**一个写入者**（`toon.ts::applyCharTint(flashT, burnT)`），并且要定顺序（这里是先燃烧后红闪：瞬时提示要压在常态光之上）与去重（按两个通道成对去重，空闲角色每帧只花两次比较）；③ **"好不好看"依旧可以被量化**：这一条用上一轮建的调性模型把"黑洞"变成数字——同一敌人的身体亮度 0.178 → 0.555，而地砖 0.239，即从"比地面暗"变成"明显亮于地面"，同时断言不能过白。**通用规则**：一个暗场里任何"只加光、不发光"的特效，都要问一句"它旁边那个不透明物体自己会亮吗"。
- **像素化后处理的稳定性不是"把分辨率调低"就自动有的：它同时依赖投影与相机对齐**（射击子应用这一轮）：常见做法是"渲染到小 target 再放大"，但那只是**块状**，画面一动就会在块网格上滑动、边缘发颤。稳定需要两个条件同时成立：① **正交投影**（`OrthographicCamera`）——世界每单位对应的像素全屏恒定，才存在唯一一个"块的世界尺寸"可对齐；透视下同一个块在不同深度覆盖不同世界尺寸，没有任何对齐量能同时成立；② **相机对齐到块网格**——正交下相机平移 `d` 使画面精确平移 `dot(d,right)`/`dot(d,up)` 像素，所以把相机位置沿它自己的 right/up 轴量化到整块，世界就会"整块地"移动而不是滑动（代价是玩家按块步进，这正是像素风的观感）。**这一条是可断言的**，而且必须断言，否则没人能看出实现是否真的稳定：`scripts/verify-postfx.mjs` 用 **vendor 的 three 摆一台真实的正交相机**、投影一个固定世界点，断言"亚块位移下**亚像素余数完全不变**、且只会在相邻两列之间跳"，并反向断言**不对齐时 61 个采样里有 50+ 个落在格点之外**——把"稳定性"变成一条会红的回归断言，而不是截图上的感觉。顺带一个几何事实值得记住：**平行投影与透视投影的可见地面互不包含**（平板在近处更宽、远处更窄，楔形相反），所以"换成正交不会少看东西"是错的；真正要守的是"阴影盒 100% 覆盖**当前**投影的可见地面"，测试也只断言这一条。

- **中间 render target 的「合成色彩空间」是一个设计决定，不是可以不管的细节**（射击子应用的像素化，三轮真机反馈才收敛）：three 只在**画到画布**时应用材质的 `linearToOutputTexel`；`getParameters()` 的规则是 `outputColorSpace = currentRenderTarget === null ? renderer.outputColorSpace : (rt.isXRRenderTarget ? rt.texture.colorSpace : LinearSRGBColorSpace)` —— 也就是**中间 target 默认是线性光缓冲**。这条默认值决定了 frame 里所有 `dst` 空间的混合（乘性暗角、黑色 alpha 遮罩、加色辉光）在**线性光**里发生，而不是在屏幕上；本项目所有观感（雾、调性、暗角、遮罩、辉光）都是按「屏幕上的值」调的，所以实测偏差很大（用户设置 `vignette 1.5 / vision.dim 0.25`：角落亮 32–39%、被遮暗的角落亮 49–62%、曳光弹反过来暗 74/255）。**三轮的教训按顺序记**：① 第一轮：blit 忘了做转换（把线性值当 sRGB 显示）→ 整屏偏暗、色相全错（实测地砖灰 `#83878b`→`#3a3e42`、Lv2 绿 `#4caf50`→`#126d14`、金 `#ffc107`→`#ff8801`、龙息弹芯 `#ff4200`→`#ff0e00`）；② 第二轮：在 blit 里补一次转换 —— 修好了**存进去的值**，但**混合仍然在线性空间**，于是「像素化后颜色都变亮了」；③ 第三轮（现在的做法）：**把离屏那一遍整体做成 display-referred** —— 全局覆盖 `ShaderChunk.colorspace_fragment`（原文本是 `gl_FragColor = linearToOutputTexel( gl_FragColor );`）为**无条件 sRGB 编码**（`gl_FragColor = sRGBTransferOETF( gl_FragColor );`），于是每个材质不管画到哪个 target 都写显示值，target 的合成与画布**逐位一致**，而 blit 退回**纯拷贝**（此时再放 `#include <colorspace_fragment>` 就是二次编码）。**为什么是全局覆盖**：场景里约 20 种材质（toon/粒子/血条/激光/光束/叠加面/描边…）必须全部一致，逐个打补丁迟早漏一个，混一点就是两个空间混在一帧里；`ShaderChunk` 在 vendor 的 three 里是**未被冻结**的普通对象，且 `#include <...>` 是**编译期**从它解析的，所以一次赋值就够。**画布路径逐字节不变**：对 sRGB 画布，`linearToOutputTexel` 生成的就是 `sRGBTransferOETF`（`LinearTosRGB` 也只是转调它）——这条等价被源码级断言钉住。**两个必须记住的坑**：① **裸 `clear()` 不跑任何着色器** —— 颜色背景（`scene.background` 是一个 Color）走的是 `state.buffers.color.setClear`，而且 three 给 render target 的 clear 喂的是**工作空间**分量，所以离屏那一遍必须换成「存的分量就是显示字节」的那个 Color，否则 `#0b0e14` 会被写成接近纯黑；② **别用「把 target 纹理标成 sRGB」来解决** —— 那会让采样端硬件解码，而且整条管线就变成依赖「驱动会不会在 framebuffer 写入时也转换」这种本环境无法验证的行为。**代价**：离屏那一遍每个片元多一次编码（一次 `pow`，此前是恒等），真机看帧率。**验证方式**：`verify-postfx.mjs` 用真实模型断言 display-referred 下暗角/遮暗/加色与直画路径**逐位相同**，并把线性 target 的偏差量作为回归守卫留在套件里。**还有一条同源的坑：合成空间一致 ≠ 画面一致，覆盖率也必须一致。** 「比一个 texel 还细的亮元素」（曳光/激光/光束/描边/火花）在**单采样**的离屏 target 里只有「全亮」或「全无」两种取值，而多采样的画布给的是真实覆盖率——实测一条 0.6 texel 宽的亮线在离屏那一遍读成 **+67% 亮**（或整条消失，取决于亚 texel 对齐），在「环境光 = 0」这种暗场里这些细亮元素就是画面最亮的内容，于是又被读成「像素化后颜色变亮」。**修法**：给离屏 target 加 `samples: 4`（`postfx.ts::PIXEL_MSAA_SAMPLES`），代价基本被「target 只有画布的 1/block² 像素」抵消；不支持多重采样 renderbuffer 的环境 three 会静默忽略该字段（退回旧行为，只会更接近）。**通用结论**：把画面搬到离屏缓冲时，**色彩空间、混合空间、覆盖率**是三件必须逐条对齐的事，少一条都会以「颜色不对」的形式暴露出来。**这条已经在真机上闭环**：强刷后把「像素化」在 0 / 2 之间拖，颜色完全一致（此前报了两轮的「颜色都变亮了」消失）。剩下未确认的只有离屏 4x MSAA 与多一次编码的帧率代价。
- **「显示空间算子」必须自己钳定义域：编码不钳制，帧缓冲到算子之后才裁剪**（射击子应用，真机报「龙息弹/RPG 的红光照到别的地方发绿」，并明确纠正「和像素化后处理无关，关掉像素化也有」）：调色/暗角这类**按"屏幕上的值"写**的算子，很容易被当成"反正最后会 clip"而省掉输入钳制。但 `linearToOutputTexel()` 只是编码（`LinearTosRGB` 里没有 `clamp`），超白值会**完整地**进入算子，只有帧缓冲在**算子之后**才裁剪。对 mix 类算子（雾）无害；对 `mix( before, after, s )` 且 `s > 1`（外推）就是灾难：`after` 已被钳到 1 而 `before` 没有，于是**唯一那个超界的通道被按 `s × (before - 1)` 往下推**，红色通道塌到绿色通道之下——**红光渲染成绿光**。实测：龙息弹弹丸光下方 0.5 单位的地砖线性值 2.9（编码后 1.6），旧代码下显示 `#6a9b3a`（绿）；RPG 爆炸（强度 90）把 R 推到 **-0.67**。**修法只有一行**：`vec3 gBase = clamp( gl_FragColor.rgb, 0.0, 1.0 )`，此后 `mix` 的基准量用它。**两条通用规则**：① 任何"显示空间/输出空间"算子（调色、暗角、锐化、dither）都应在入口把输入折进自己的定义域——因为**上游从来不保证**，而下游的裁剪不算数；② **色彩空间的差异只会改变超界的幅度，不会改变符号**——所以同一个缺陷在"渲染进 render target"和"直画画布"两条路径上都会出现，只是幅度不同；用"换个后处理设置就复现/不复现"来判定根因会得出错误结论（这一轮先误判成像素化的问题，被用户纠正）。
- **模型若比被建模的系统更宽容，它就会替系统圆谎**（同上这一轮，这是最有价值的一条）：`tone.ts::shade` 在编码处写了 `Math.min(1, …)`，而真实 shader 没有——于是**纯 CPU 模型一直报"不会发绿"，而真机一直发绿**，两者差了整整一轮反馈周期。**对策**：凡是"复现渲染管线"的模型，每一处钳制/饱和/舍入都要能指到渲染器里的同一处（本项目现在的写法是 `grade.ts` 自己钳输入，模型那行 `Math.min` 与 shader 的 `clamp` 是同一个钳制）；模型比系统宽松的地方就是**模型不可信的地方**，宁可让模型报错也不要让它替系统兜底。**顺带**：断言要留一条**旧算法的原样复现**（`verify-tone.mjs` 里留着未钳制的 kernel，断言它在同一输入上确实发绿）——否则"加了钳制"这条断言无法证明它修了什么。
- **`camZoom` 这类"移动相机"的补偿，在正交投影下会静默失效**：本项目的 `camZoom = 视口高/参考高` 原本靠**推拉相机**让横竖屏的角色尺寸一致。正交相机移动位置**完全不改变画面**（只影响深度裁剪），所以旧写法在换投影后不会报错、只会让横屏补偿无声地死掉。正确做法是把同一个因子**乘进 frustum 的尺寸**（`orthoFrustumHeight(scale, camZoom)`）。**通用检查项**：任何"通过移动相机来改变取景"的代码，在换成正交（或任何平行投影）后都要重新问一句"它还在改变画面吗"。
- **"横屏比竖屏分辨率低"这类报告要先拆成两个独立的量：渲染了多少像素、每个像素盖住多少世界**（射击子应用，真机反馈的排查结论）：这两个量混在一起时，任何"调分辨率"的直觉都会走错方向。① **像素数只由 `视口 / 块大小` 决定**——离屏那一遍渲染 `viewport / block` 个 texel，`block` 是 CSS px、内部乘 DPR 后再取整，所以 `target = 视口/block`，**与 DPR 无关**（`像素化 ≥ 1` 时渲染器的 DPR 上限完全不参与；只有关掉后处理走直画路径才吃 DPR）。于是**在两边 `block` 相同时旋转手机不改变渲染的像素数**（同一块 CSS 面积），报告者的机器上竖横两向各 347,600 texel；两个方向的 `block` 不一样时，渲染分辨率才会真的不同（那是设置差异，不是管线差异）。② **每个像素盖住多少世界只是相机姿态的函数**：`世界/CSSpx = 2·距离(heightScale)·tan(FOV/2) / CAM_REF_H`（视口高度在 `camZoom = 视口高/参考高` 里被约掉），所以**同一个 heightScale 下横竖屏逐位相同**。真机上"横屏糊"因此几乎总是**per-orientation 的用户设置不一样**（本项目 `camera.landscape.heightScale = 2.1` vs `1.55` ⇒ 1.35× 更粗、同屏世界面积 1.84×），而不是渲染管线的问题；第二条路径是补偿因子的**钳制**（`clamp(h/800, 0.42, 1.15)` 在 336–920 CSS px 的视口高度之外会打破等价性）。**通用规则**：把这类抱怨先算成两张表（每向的 texel 数、每向的 世界/CSSpx），再问"这几个数里哪一个真的和方向有关"——答案几乎总是"用户设置"或"某个钳制"，而不是分辨率本身。两条都做成了会红的断言（`scripts/verify-postfx.mjs` 第 5 节）。
- **「看起来还行」不是验收标准：没有浏览器时，先把度量做出来（画面调性那一轮）**：这个项目此前所有美术决策（地砖灰阶、环境光、雾）都是「发到真机上看一眼再改」，因为环境里**没有浏览器、没有 GPU**。这一轮换了做法：把渲染管线（主光/暖补光走 toon 台阶、环境光走间接辐照、`× 反照率 / π`、sRGB 编码、再叠雾与调色）在纯 JS 里重现（`apps/shooter/src/tone.ts`），把**场景调色板的实测值**喂进去（地砖的 `PropDef.tint`、Kenney wood 的 glTF `baseColorFactor`、**用 node 解 1024² 角色图集统计出的主色**），输出对比度 / 主色占比 / 色相分布 / CIE Lab ΔE 与 7 组关键可辨识度（`scripts/analyze-tone.mjs`）。**第一次跑就量出了三件只有肉眼才能发现的事**：画面 **暖 51% / 冷 3%**（几乎没有冷暖对比——「发平」的量化版本）、角色与地砖 **ΔL* ≤ 5**（只靠饱和度区分）、**玩家与敌人 ΔE 仅 6.9**（两者共用一张暖棕图集，占位体里那套青/红色码在加载 GLB 时就丢了）。改造（冷暗部 × 暖亮部的**乘性** split-tone + 暗角）之后，同一份报告给出 **对比度 71.4 → 79.2、冷色 3% → 48.7%、7 组可辨识度全部上升且黑场未被抬升**——于是「改好了」变成可以被反驳的断言，而不是一句感觉。**三条可复用的规则**：① 当一个纯函数 + 一份数据就能把「审美」翻译成可回归的数字时，**先做这个翻译再动手改画面**；② **报告与门禁分开**（`analyze-tone.mjs` 只打印，`verify-tone.mjs` 才是断言），探索时不被测试绑住、回归时又跑不掉；③ 调色要是**乘性**的（暗部染冷色而不是被提亮），因为 additive 的 lift 会悄悄抵消用户「环境光 = 0」的要求——这一条也被断言（`gradeDisplay([0,0,0], 1)` 必须精确等于 0）。**局限写在代码顶部，不要外推**：这个模型看不见阴影、屏空间构图与逐像素细节，它是**调色板模型不是截图**（记分卡里的 `edgeDensity`/`colorEntropyBits` 那类像素指标它给不了）。
- **多个 `onBeforeCompile` 补丁叠加时，「应用顺序」与「插入顺序」是反的**：每个补丁都写成 `src.replace(ANCHOR, ANCHOR + BODY)`，即**插在锚点之后**；于是第二个补丁的块会排在第一个的前面——**「先打雾再打调色」实际得到「调色在前、雾在后」**（雾把分级结果再冲淡一层，看起来像「分级不起作用」，且没有任何报错）。这一轮把 `toon.ts` 改成**一次替换同时插入两个块**、顺序写在代码里，并让 `verify-tone.mjs` 断言合成后的 shader 里 `uFogColor` 出现在 `gLum` 之前——**外加一条「链式调用会反序」的回归断言**，把这个坑本身钉住。推论：任何「往同一个 shader 里插多段代码」的系统都该在**合成后的源码上**断言顺序，而不是信任调用顺序。
- **加进场景 ≠ 加进相机：`camera.add(mesh)` 只更新矩阵，永远不会被渲染**：three 的渲染器只从 `scene` 开始遍历（`projectObject(scene, …)`），相机**不是场景的一部分**，所以挂在相机下的网格既不绘制也不报错——「屏幕效果什么都没出现」这类静默失败里它最常见。想贴屏幕又不想引入后处理管线（vendor 里没有 addons），正确做法是**放进 scene，每帧复制相机的 `position`/`quaternion` 再沿视轴后退**（本项目的 `render.ts::syncVignette()`），这也正是世界空间血条一直在用的技巧。
- **给既有材质加自定义 shader 时，「锚点存在」必须是被断言的前提，而且补丁要全有或全无**（射击子应用的高度雾，本仓库第二次写着色器）：做法是 `onBeforeCompile` 里对 `shader.vertexShader`/`fragmentShader` 做字符串替换（`#include <project_vertex>` 之后注入世界高度捕获；片元侧注入在 `#include <colorspace_fragment>` 的**左边**、并夹在显式的显示空间编解码之间，见本节的 ③）。两件事必须做到，否则会出「看起来很合理但完全错了」或者「整屏不渲染」的结果：① **锚点是外部依赖**——`String.replace` 找不到目标时是**静默空操作**（雾从此永不出现，且没有任何报错），所以 `scripts/verify-fog.mjs` 直接 import **vendor 里那份 three**，断言两个锚点在每个受光材质的 shader 里**各出现且仅出现一次**，并把「注入点落在最后一个 chunk」也断言掉；② **缺一个锚点时必须整体放弃**——只补片元不补顶点会用到一个没声明的 varying，那是**编译失败**（材质消失/整屏黑），而「雾没出现」是可接受的降级，所以补丁函数返回 `{ok, src}`、调用方在任一失败时两段都不改。**另外两条同类经验**：③ **注入位置决定色彩空间，而且「最后一个 chunk」是个陷阱**——第一版把混合追加在 `dithering_fragment`（片元最后一个 chunk）之后，理由是"那就在 `colorspace_fragment` 之后，属于输出空间"。这对**画布**成立，对 **render target 不成立**：three 对非 XR 的 render target 强制 `srgb-linear`，于是那条 include 展开成恒等，同一段代码在家用两条路径上拿到**不同的空间**（实测同一块地砖的雾浓度差约 10/255，且没有任何报错）。正确做法是**注入在 `colorspace_fragment` 的左边**（唯一一条随渲染目标变化的语句），并在那段代码里**显式跨过这条边界**：用 three 自己的 `LinearTosRGB` 进、手写 sRGB EOTF（vendor 里没有逆函数，因为贴图解码是采样器内部格式做的）出，中间才是"按屏幕上的值"写的算子。颜色要按「屏幕上的值」给（原始 hex 字节）；写 `new THREE.Color(hex)` 会被线性化而明显偏亮——同一份代码里两种颜色语义并存，是这里最容易踩的一处；④ **世界坐标公式要抄引擎自己的**——本项目道具全是 `InstancedMesh`，注入时漏掉 `worldpos_vertex` 里的 `instanceMatrix` 分支**不会报错**，只会让整个房间按「所有道具都在原点」计算高度，看起来「雾有点怪」。测试用归一化字符串比对，把注入的表达式与 `ShaderChunk.worldpos_vertex` 钉成等价；⑤ **`Material.clone()` 会丢补丁、却会深拷贝 `userData`**——实例级的 `onBeforeCompile` 不被复制，而 `userData` 被复制，于是克隆体"看着已打补丁、实际没有"，幂等守卫还会阻止重新补。凡是"每实例克隆材质"的渲染器（本项目角色就是）都必须在克隆路径里清标记 + 重新注册；这条不要凭记忆写注释，直接拿 vendor 的 three 在 node 里 `clone()` 一次断言它（`verify-fog.mjs` 就是这么做的）。
- **⚠️ 最坏的情况不是"撞上窗口"，而是"两个构建同时在换目录"——那会把 `dist/` 留成残缺树，而且 watcher 不会自己发现（本次真实踩到）**：`build.mjs` 是「`rm -rf dist.next` → 编译进 `dist.next` → `rm -rf dist` → `rename dist.next dist`」，这套动作在**单个**构建里是原子的；但 `npm run dev` 的 watcher 在轮询到源码变化时会自己跑一遍同样的动作，此时若**手动**再 `npm run build`，两个进程的 `rm`/`rename` 就会交错。本次现象：12 个验证脚本全部 `ERR_MODULE_NOT_FOUND`，`dist/` 只剩 79 个文件（少了 `dist/server/` 与几乎整个 `apps/shooter/src/`），`curl /apps/shooter/` 返回 **000**（服务器进程根本没起来）。**两条教训**：① **有 watcher 在跑就别手动 build**（AGENTS.md 已有这条规定，这里是它的具体代价）；② **watcher 只轮询源码目录（`server/ apps/ shell/ shared/ scripts/`），`dist/` 不在它的签名里**，所以它**不会**因为 `dist/` 被改坏而重启或修复——恢复动作是「**确认没有别的构建在跑** → 干净地 `npm run build` 一次 → `touch apps/shooter/src/<任一源文件>` 让 watcher 自己重建 + 重启服务器 → `curl` 确认 200」。不要用「再跑一次手动 build」来代替第 3 步，否则服务器仍然是旧进程/没进程。
- **行为快照的基准会被「刻意的平衡改动」改写**：`scripts/trace-shooter.mjs` 是逐帧指纹，射速 1.2s→1.0s、加入燃烧、射速 1.0s→0.6s + 弹夹/换弹、新增冲锋枪场景、火箭伤害 -30%/半径 +50%（爆炸粒子从 81 涨到 95）、背包/备弹/护甲（每行新增备弹 `V`、弹药等级 `L`、敌人护甲 `V<value>/L<level>`）、以及每弹药覆写表（每行新增 `P<穿甲>`，且龙息弹的伤害数值本身变了）这类改动**本来就会**让它变（当前基准 `md5 = 8f7f67b17052c491266c492c7d042a58`，2700 行——**行数变了**，因为本轮新增了场景 ⑤）。它是用来证明「重构没有改行为」的，不是用来证明「平衡数值永远不变」的——改完要重新记录基准，并在提交说明/文档里写清为什么变了（本项目多次都这么处理。**最近一轮「武器后坐力」的举证**：每行多一个 `C<x>,<z>` 后坐力向量；把 `GameSim.prototype.addRecoil` 打桩成空函数、并把新字段从输出里去掉后重跑，得到的正是再上一版基准 `48959b6a…` —— 这就是「本次改动对模拟的全部影响只有后坐力状态本身」的举证）。**本轮（枪口特效）为什么变**：枪口粒子由**模拟层**生成，于是多了 `Math.random` 消耗——这正是本文件头写的「刻意的行为变更」，与平衡无关。**重采之前先证明「变的到底是什么」**（这一步本轮真正做了，值得沿用）：把新的特效入口 `GameSim.prototype.spawnMuzzleFlash` 打桩成空函数、用同一份 PRNG 重跑快照，输出与**上一版基准逐字节相同**（`d9259741…`）——即本次改动对模拟的全部影响就是枪口特效本身，1982 行不同全在 `P[...]` 段。**最近一轮（敌人攻击欲望：预警 0.5s → 打空一梭子 → 换弹，且枪手复用冲锋枪配置）为什么变**：敌人的**每一发**都要抽一次 `Math.random()`（散布）并生成枪口粒子，连发的抽取次数远多于旧的"一发一歇"，此后共享同一条 PRNG 流的逐帧轨迹整体偏移。**举证方式（沿用上面那条标准做法）**：用**旧提交单独构建**跑了一遍快照，**逐字节复现出上一版基准 `ff19640b…`**，说明变的确实只是这一轮；差异位置也对得上——场景 A（无枪手）逐字节不变，B 的前 168 帧不变、`B168` 出现第一发敌方子弹后才开始差，C 的前 59 帧"看着一样"只是那几帧还没消耗任何随机数（第一个敌人在 C59 才生成）。比「反正重采了」强得多的一种交代：**打桩复现旧基准**是「新增事件消费随机数」这类改动的标准举证方式。**最近一轮（操作方案：右摇杆转视角 + 角色永远朝相机前方 + 独立开火键）为什么变**：这一轮唯一的**玩法**改动是 `game.ts` 的朝向条件（`if (hasAim && p.firing)` → `if (hasAim)`），它只影响「有方向但没有开火」的帧。**举证方式（这一轮不能再用旧提交——上一轮的敌人改动也还没提交）**：把那一行**临时改回旧条件**、等 watcher 重建后重跑快照，**逐字节复现出上一版基准 `398106ab…`**；再改回来，得到新基准。差异实测**只有 40 行，全部落在场景 A 的第 100–119 与 220–239 帧**（`firing: i % 120 < 100` 为假的那 20 帧），**B/C/D 三个场景逐字节不变**（它们要么恒开火、要么 `aim` 为 0，两种规则走同一分支）。纯输入层 / 渲染层 / 设置项的改动（右摇杆映射、开火键、头顶血条、设置面板）**不进快照**：`trace-shooter.mjs` 只跑模拟、不建渲染器，`input.ts` 与 `render.ts` 都不在它的覆盖范围里——这也是为什么快照**能**分辨「玩法改动」与「控制/表现改动」。**紧接着的一轮（右摇杆 → 大面积透明「视角区」+ 方向反向）正好是后者的教科书例子**：符号反在 `camera.ts::stickYawTarget`、透明在 `styles.css`、尺寸在 `settings.ts::lookPadSize`，**快照实测逐字节不变（仍是 `6083aabd…`）**——「该变的变了、不该变的一点没动」是同一个工具的两面。**本轮（开火辅助：15° 锥 + 停火回正）基线重采为 `8f7f67b1…`（2700 行），而这次是「加场景」型重采，值得单独记一笔**：模拟层确实改了（`update()` 的 `aimDir` 解析、`nearestVisibleEnemy` 的可选锥参数、`CONFIG.autoAimConeDeg`），但**四个旧场景一个都看不见它** —— B/C 虽然 `autoAim: true`，传的却是**零方向**，走历史那条「最近可见、不加锥」的分支。也就是说「快照逐字节不变」在这里会变成**假阴性**：模拟层改了、指纹却没动。于是补了**场景 ⑤**（等距的两个不死靶在相机前方 10° 与 25°，100 帧开火 + 50 帧停火），**举证方式是 `head -2100` 的 md5 仍逐字节等于上一版 `6083aabd…`**：既证明 A–D 一点没动，也证明本次重采的全部新增就是那 600 行。**通用教训**：快照的覆盖范围由**场景的输入形状**决定，不由代码的归属决定 —— 加一条新分支时，先问「现有场景会走到它吗」，不会走就得补场景，否则回归门禁会在最关键的地方静默失效。**反向的一例（爆炸火光那一轮）**：给爆炸加一盏瞬时光源**没有**消耗任何随机数、也没有新增粒子，所以那一轮的快照 `md5` 必须与上一版**逐字节相同**（实测确为 `48959b6a…`）——「纯状态层的改动不该动快照」和「新增粒子必然动快照」是同一个工具的两面，**改动前先想清楚自己属于哪一面**，跑一次就能自证。**反向的一条同样重要**：**纯渲染层的改动（视野遮挡、削弱环境光）必须让快照逐字节不变**，因为 `trace-shooter.mjs` 只跑模拟、不建渲染器——`md5` 不变就是「模拟层一行没动」的直接证据（也正因为如此，光照观感**不可能**被这个快照发现，只能靠纯模块断言 + 真机）。**顺带**：场景里补备弹这件事本身也是「让快照继续测它声称在测的东西」（射速/节奏），否则它会悄悄变成在测「背包还有没有子弹」。
- **冷却计时器要用容差判定，否则每发都晚一帧（本次真实踩到）**：冷却实现是每帧 `timer -= dt`，而「数学上刚好整除」的冷却在 IEEE 754 下**不保证归零**——实测 60fps 时 0.1s 剩 `+2.1e-17`（6 帧）、0.2s 剩 `+4.9e-17`、0.5s 剩 `+1.0e-16`、1.6s 剩 `+7.7e-16`，20fps 时 0.6s 剩 `+1.4e-17`。判定写 `timer <= 0` 时这些全部**多等一帧**：冲锋枪 0.1s 变成 7 帧 = 0.1167s（慢 16%），砍刀 0.5s → 0.5167s，火箭筒 1.6s → 1.6167s（这个坑**在加冲锋枪之前就存在**，只是没人量过）。修法：`apps/shooter/src/game.ts` 的 `TIMER_EPS = 1e-9`，`timer <= TIMER_EPS` 才算到点。选值依据：比观测残差高 7 个数量级，又比任何帧长小 7 个数量级，不可能提前开火。**不要**把判定改回 `<= 0`。同类教训：任何「累加/累减浮点直到过零」的计时器都要想一下残差符号。
- **弹夹状态不能写进武器定义（共享只读数据），而「切换武器不能补弹」又要求它跟着武器走 → 结论是存在武器物品上**：`RangedWeaponDef` 是共享的，把 `ammo` 写进去会被所有持有者共享（敌人 AI / 第二个玩家会一起打光）。最初的做法是「`magSize`/`reloadTime` 在定义里，`Player.ammo`/`reloadTimer` 在玩家上」，但**加入备弹系统后就站不住了**：玩家只要反复切枪就能让弹夹被重新填满，整套「子弹会变少」的意义被一个动作绕过。现在的形状是 `apps/shooter/src/items.ts` 的 weapon 物品带 `{ammo, primed}`——切枪只是换了一件**带着自己子弹**的物品，`Player.ammo` 只是它的实时镜像（`commitMag()` 写回）。`primed: false` = 「下次握在手里时从背包装填」，所以「第一次拿到这把枪」与「切回来」是两件不同的事；强制塞枪的 `equipWeapon()` 必须把旧枪余弹 `addAmmo()` 退回背包，否则它就是另一条静默丢失/凭空补给的旁路。另一个必须守的顺序不变：**只有 `fireWeapon()` 返回 true 才扣弹药**（远程武器没有瞄准方向时返回 false），否则按住扳机对着空气会把弹夹打光；换弹结束要在**当帧**允许开火（`fireTimer` 换弹期间继续倒数、允许为负），否则每轮换弹后白等一个冷却。
- **量「间隙」要量玩家看得见的那一层：填充 ≠ 框**：敌人血条与护甲条各有一次「填充」（彩色，逐实例缩放）和一层「暗框」（固定大小、比填充每边大 `BAR_PAD`）。第一版把两条之间的间距量在**填充边**上（0.28 世界单位，代码里看着很宽），而框还会向外各扩 0.05 —— 于是两个**框**实际重叠了 0.05 单位，真机反馈是「护甲条和血条太重叠了」。现在的做法是：① 间距定义成 `BAR_FRAME_GAP`，由 `barFrameTop()` / `barFrameBottom()`（**框**边）推出 `ARMOR_BAR_Y`；② 导出 `ARMOR_BAR_CLEARANCE` 并在 `verify-inventory.mjs` 里断言 `>= 0.15`、且换算到参考取景 ≥ 4px；③ 那条「净空 = 填充净空 − 2×BAR_PAD」的断言直接把这次的错误关系钉死。**玩家头顶那三条也走同一套**（`PLAYER_ARMOR_BAR_Y` / `PLAYER_RELOAD_BAR_Y` 各自由上一条的**框**顶推出，`PLAYER_ARMOR_CLEARANCE` / `PLAYER_RELOAD_CLEARANCE` 各有断言），所以「多一条 bar」不会重新引入同一类重叠。**通用教训**：任何「两个 UI 元素不能挨太近」的规则，都要按**最外层可见几何**（框/描边/阴影）算，并且把它做成可在 node 里断言的数——只按内层量，代码评审永远看不出来，只有真机能。
- **「默认规则 + 每对象覆写表」要分层，而且不合法的覆写项必须回落默认**：护甲伤害的默认阶梯（甲伤 ×0.7/级、肉伤 100/75/50/0%）只是默认，每种弹药可以为 1–6 级护甲各覆写一条系数（`ProjectileDef.vsArmor` / `vsFlesh`，单位是同弹丸伤害的倍率）。`armor.ts::roundArmorMul/roundFleshMul` 的解析顺序是「先查表项 → 表项必须是有限且 ≥ 0 的数字，否则用默认公式」。这一条的关键在于**半张表必须合法**：只写前 3 项、写 `null`、写负数/`NaN`/字符串，都只影响它自己那一项，其余继续跟默认走。如果实现成「表存在就整表生效、缺项当 0」，那么漏写一项 = 静默变成 0 伤害，而且脏数据会直接产出 `NaN` 血条。另有两条配套：① 「不传档案 = 无视护甲」要保留成一个**显式**分支（燃烧/近战/接触伤害故意不走护甲），并且 `resolveHit` 的档案参数接受 `RoundProfile | number`（数字按 `{level, penetration}` 解释），旧调用点与测试因此不用改；② 覆写是**个例**，绝不能用改默认公式的方式表达 —— 那会把所有弹药一起改掉。
- **一个对象的「显示值」和「结算值」分开之后，UI 颜色就不再等价于能力（必须写进文档）**：弹药现在有 `level`（1–6，只用于 HUD 徽章与背包格子的颜色）和 `penetration`（0–6，喂给默认公式），两者的样板差异就是龙息弹：**显示 Lv4、穿甲 0**。于是「弹药徽章的等级色 vs 敌人护甲条的等级色」**不再能预测能不能穿透**。这类拆分本身是对的（同一个显示等级可以有完全不同的实际行为），但它的副作用是**用户界面在说谎**，所以要么在 UI 里把结算值也显示出来，要么像本项目这样在 `armor.ts` 顶部、README 与已知限制里各写一次。**判据**：任何时候把「给玩家看的数」和「参与计算的数」拆成两个字段，都要问一句「玩家能不能从看得到的那个推断出实际行为」。
- **同一池子里画多个物体时，「每个物体一份槽位」必须做成结构而不是手写 `+1`（真实踩过）**：世界空间的血条与护甲条共用两个 `InstancedMesh` 池，每条 bar 要 1 个 frame 实例 + 1 个 fill 实例。第一版把血条和护甲条的 frame 都写在同一个下标上（`writeBarFrame(bn, …)` 两次、`bn++` 一次），护甲条的暗框就**覆盖了血条的暗框**——真机反馈「显示护甲条的时候，血条就丢失背景了」（填充侧当时用了独立的计数器，所以只有框这一半坏）。修法是把分配器做成纯函数（`hud.ts::createBarAllocator`，`render.ts` 每画一条 bar 必须先 `next()` 拿槽位、池满就停止绘制），于是「不共用槽位」与「容量够用」都能在 node 里断言（`verify-inventory` 断言连续 `next()` 的 `frame`/`fill` 两两不同且递增；`MAX_BAR_SLOTS = 128*2+1` 在 128 个带甲敌人 + 换弹条时刚好够）。**为什么不是就地 `+1`**：那只是把 bug 修掉，没有把规则固化；下次再加一条 bar（比如技能冷却条）时同样的错误会再犯一次。
- **移动端的拖放不能用 HTML5 DnD，而且「格子」与「面板」的 `touch-action` 天生冲突**：`dragstart`/`drop` 这套在触摸设备上**根本不会触发**（本项目是触屏优先），所以背包的拖放只能用 pointer 事件：`pointerdown` 记来源 → `pointermove` 跟手 + `document.elementFromPoint()` 找目标 → `pointerup` 提交。两个必须踩对的细节：① **拖影必须 `pointer-events:none`**，否则 `elementFromPoint` 永远返回拖影自己，目标永远解析不出来；② 命中解析不要用 `closest()` 往上找（那种写法更难在 DOM shim 里复现）——把 `data-ref` 直接放在格子上、并让格子的子元素 `pointer-events:none`，那么指针下的元素本身就带着 ref。另一半是滚动：面板需要 `touch-action:pan-y`（连同**所有后代**，见另一条「面板不能滚动」的坑），但 `.inv-grid` 必须设回 `touch-action:none`，否则一次竖直拖动会被浏览器解释成滚动面板而不是拖物品——**两者只能在不同的元素上分别声明**。顺带：拖放之外还做了「点一下来源、再点一下目标」的移动路径（位移 < 8px 视为点选），因为用拇指把小格子精确拖到另一个小格子上本来就不好用。
- **纯模块之间可以用「类型专用」的引用打破循环，但必须写清楚**：`weapons.ts` 需要 `AmmoId` 这个联合类型，而它属于 `items.ts`；`items.ts` 又（在运行时）依赖 `projectiles.ts` 取弹药等级。如果 `weapons.ts` 用**值**导入 `items.ts` 就成环了，所以用的是 `import type { AmmoId }`（tsc 擦除，运行时的依赖图里根本没有这条边）。方向因此是 `items → projectiles → weapons → inventory → game`，`weapons → items` 只活在类型层。选这条而不是「把 `AmmoId` 定义在 weapons.ts 里」，是因为那样「弹药等级」就有了第二个真相源。**判据**：一端的导入全是类型就不算环；但要在文件里写明，否则下一个人改成值导入会得到一个很难懂的运行时错误。
- **同一套「等级」的视觉语言只能有一份色表，而且必须显式声明哪些地方**不**跟随它**：护甲/子弹的 1–6 级配色（白/绿/蓝/紫/金/红）只在 `armor.ts::LEVEL_COLORS` 里定义一次，`items.ts`（物品定义不带 `color`）、`hud.ts`（只返回等级数字）、`render.ts`、`inventoryPanel.ts` 全部从这里取色。**但世界里的曳光弹刻意不换色**：加色材质在 1.0 处逐通道截断（配色必须压低 G/B 才能保住色相），而紫红 = 敌对是混战里唯一的来源提示。这类「有一套新配色但只有一部分 UI 该用它」的情况，一定要配一条**负断言**（`verify-inventory.mjs` 断言没有任何 `ProjectileDef.visual` 的颜色等于任何等级色），否则下一个人「顺手统一一下」就会把两条既有规则一起悄悄破坏。
- **触屏上「第二个手指点不动按钮」：不要依赖 `click`**：`click` 是浏览器手势识别器合成的事件。当第一根手指已经按在摇杆上、而摇杆元素调用过 `setPointerCapture()`（`apps/shooter/src/input.ts`）时，第二根手指轻点另一个元素**经常不会产生 `click`**——真机反馈就是「按住摇杆时点切换武器按钮没反应」。修法：按钮改由 `pointerdown` 驱动（每个指针独立派发、不需要合成），键盘用 Enter/Space，并且**故意不监听 `click`**——`pointerdown` 与 `click` 同时监听会让一次点击切两把武器，而去重需要计时器/标志位，反而不可测。接线抽到无依赖的 `apps/shooter/src/weaponButton.ts`，用 `verify-panel.mjs` 的 DOM shim 断言「只绑 pointerdown + keydown、没有 click 监听」。附带两条：命中区从 ~21px 加高到 28px（横屏 24px），`#hud` 的 `z-index` 从 5 提到 7（高于摇杆 6）——`#hud` 是 `pointer-events:none`，抬层级不会抢摇杆输入。
- **加色混合画不出「深色」，所以烟和碎片必须另开一个正常混合的粒子池**：`apps/shooter` 的粒子材质一直是 `AdditiveBlending`，而加色混合在数学上只能让像素变亮——深色烟贡献 0（完全不可见），深色碎片同理。RPG 爆炸要「烟火 + 碎片」时这一点就绕不过去，于是 `Particle` 加了 `solid: boolean`，`render.ts` 按它路由到两个 `InstancedMesh`（加色 2048 + 正常混合 512），并用 `renderOrder` 保证加色层画在正常混合层之后（火光叠在烟上）。代价是 **+1 个 draw call**，但 `count = 0` 时几乎不花钱。**顺带的坑**：粒子一旦有重力（负 `buoy`）就会暴露「`y` 没有碰撞」——碎片会穿过地板继续往下掉（实测到 y = −3.4），屏幕上的表现是「飞到一半凭空消失」；修法是在 `update()` 里对 `y < 0.05 && vy < 0` 做落地钳制。只有负浮力粒子会命中该分支，所以既有粒子（火花恒 y = 0.2、火焰只上升）零影响——trace 逐字节不变即为证据。
- **极短特效的 puff「闪烁」其实是每一次开火各自不同的随机亮度**（枪口特效这一轮）：`render.ts` 的 puff 分支用 `noise2(x*2.2, y*2.2, time*2.6 + flick)` 当亮度乘子，看起来像会闪，但 0.05s 的枪口一闪只推进 `time*2.6 = 0.13`，噪声场几乎不动——所以在 60ms 的寿命里它不是频闪，而是**这一次开火的整体明暗随机值**（0.55–1.05），正好是「每一发都略有不同」想要的效果。**推论**：短特效可以放心复用 puff 通路；反过来，**长寿命**的 puff（烟、火球）才会真的看到噪声在寿命内起伏，别把两种语义搞混。
- **动态光源池要按优先级分配，不要为每个新特效开一个新池**（枪口特效这一轮）：场景里的点光数量不只是逐片元成本，**还是 three 的 shader program key**（灯数变化 = 另一个程序变体；`visible=false` 会让灯从 `WebGLLights` 里消失、进而改变 program 缓存键）。所以枪口光与**爆炸火光**都没有自己的池，而是作为同一条**扁平**瞬时光源列表（`fxlight.ts`）的条目，在 `sync()` 里**先于子弹、从新到旧**占用同一个 8 盏池：枪口是一闪而过的强事件，子弹的辉光网格照旧画，被挤掉的只是那一两帧里最旧的几发子弹的点光。**顺带的两个护栏**：① 灯也要过 `visibleAt`（否则它会照亮「本该被藏起来」的暗区，与血条/预警光束是同一类泄露）；② 光的位置要**沿瞄准方向前移**一点——`decay=2` 的点光离射手只有 0.8 单位时会把玩家自己的 toon 台阶打到饱和，10 发/秒就是自己身上的白频闪。
- **「不要时长太长」是可以写成断言的**（枪口特效这一轮）：`muzzleMaxLife(def) < weapon.cooldown`（冲锋枪 0.09 < 0.1、龙息喷 0.26 < 0.6、RPG 0.50 < 1.6），光源寿命同约束。这一条同时挡住两个问题：连发把特效堆成常亮（冲锋枪 10 发/秒实测同屏峰值 ≤ 9 颗），以及「某把枪的特效明显比其他枪拖沓」这种只能靠眼睛吵架的评审。**做法上的推论**：每次被要求「短一点 / 快一点」时，先找一条能把该要求变成**不等式**的量（寿命 vs cadence），再调数值——数值改动会自己撞到那条断言上。
- **「在生成处测量」这条老坑在枪口特效上又出现了一次：一帧的 curl 噪声就能把最快的火花掰弯 0.2 rad**：验「星芒都在 ±cone 内」时如果按 1/60s 走一帧再量速度方向，量到的是噪声场而不是配方（实测最大 0.7575 rad > cone 0.55，而且会随采样点变化）。改用 **1/2000s** 的步长（一步只让方向偏 ~0.002 rad）后，200 次试验对 0.55 锥的最大越界是 0.0011 —— 断言才在测「出膛那一刻的锥角」。这与 `verify-melee.mjs` 那条「在 SPAWN 处测量」是同一个坑的第二次出现：**凡是粒子在生成当帧就被物理改过的量，都要在更小的步长或更早的时刻去量。**

- **世界空间 UI 复用血条那对 InstancedMesh，并注意「计时器在死亡时会冻结」**：玩家头顶的换弹条与敌人血条共用一个 `writeBar()`（`render.ts`），各写一个实例，所以整场 UI 仍是 2 个 draw call。两个坑：① billboard 必须在相机 `lookAt()` **之后**写矩阵，否则晚一帧（血条已有这个约束）；② `GameSim.update()` 在 `this.over` 时**提前返回**，所以玩家死亡那一帧的 `reloadTimer` 会**永远冻结在 > 0**——只按 `reloadTimer > 0` 判断，尸体就会顶着一根半满的换弹条，必须再判 `player.alive`。同类教训：任何「靠 update 递减的计时器」在暂停/死亡路径下都不会自己归零，显示逻辑要显式处理这些路径。
- **粒子发射要用「累加器 + 总量上限」，朝向升级要保证旧路径等价**：燃烧火焰是「每帧按速率累加、够 1 颗就喷」的（`Enemy.flameAcc += rate * dt`，帧率无关），并且**必须**同时有 ① 速率上限（`flameRateMax`，否则 40 层目标会把粒子数拉爆）② 模拟层总量上限（`flameParticleCap`，否则多敌人同时燃烧时数组无界增长；渲染池 `MAX_PARTICLES` 只是「不画」，不能阻止数组涨）。另一个坑：把粒子朝向从「绕 Y 的 yaw」升级成「局部 +Z 跟随三维速度」时，**`vy = 0` 必须与旧 yaw 数学等价**，否则所有地面火花会集体歪掉——所以这段数学抽到无依赖的 `apps/shooter/src/streak.ts`，并在 `verify-burn.mjs` 里用 vendor 的 three.js 交叉验证（含反平行与零向量分支）。**再一个坑（真实踩过）：粒子尺寸要用「屏幕像素」而不是「世界单位」来估**——参考取景下 1 世界单位 ≈ 29 CSS px，燃烧火苗第一版给了 0.10–0.19 单位（3–5 px），在 17–46 px 的溅射火花旁边**完全看不见**，玩家反馈「火焰是长条形」其实看到的是火花。火焰因此改成**面向相机的公告板**（`puff: true`：`_pq.copy(camera.quaternion)`，不再沿速度拉伸）并放大到 10–20 px，且用 `aspect=0.55` 把宽度压到高度的 55%（方形公告板在真机上读作「方块」，压窄后才像火舌）；同时因为加色混合在 1.0 处逐通道截断，**大量重叠的火苗会爆白**，所以生成时把颜色按 `flameDim=0.5` 压暗（`#ff3a1f → #7f1d0f`）。公告板必须在**相机更新之后**写矩阵，否则会晚一帧。
- **WebGL / GPU 子应用（如 `blackhole`）无法在无浏览器环境验证**：着色器要在 GPU 上编译，无法用 `node --check` 在服务器上验证。稳妥做法：先把相同的物理/算法用 **CPU 在 node 里复现并出图**（本项目用 `docs/blackhole-preview.png` 验证了 Schwarzschild 光线追踪：阴影、引力透镜、多普勒增亮、光子环都正确），确认物理后再上 WebGL。注意把 WebGL 初始化包进函数（顶层 `return` 非法），并在界面显示 `gl.getShaderInfoLog` 以便报错。本应用做**三级降级**：WebGL2 → WebGL1（把 `outColor`/`layout(in)` 转成 `gl_FragColor`，用 `precision mediump float;` 兜底）→ 直接显示 CPU 预渲染的 `preview.png`，保证任何设备都能看到黑洞。

- **「视觉可以比碰撞小、可以比碰撞高，但绝不能超出碰撞脚印」**：掩体是 2D 的 AABB，与高度无关，所以把一件冰箱（2.9 高）放在 1.5 高的掩体脚印上完全自洽——它挡住子弹是因为脚印，不是因为它高。反过来，一件伸出脚印的道具**是最坏方向的谎**：玩家看得到实心物体，子弹却从里面穿过去。所以 `props.ts::fillCover` 只允许 90° 旋转（旋转后脚印仍是轴对齐的，可以证明包含关系），网格数用「向下取整」而不是四舍五入，留出的余量变成道具之间的空隙而不是越界。**还有一个更隐蔽的版本**：给道具加了随机位移（jitter）让堆叠更自然之后，位移量必须计入尺寸预算——第一版按格子的 100% 缩放道具、再抖动 ±9%，于是有 55 件道具伸出了脚印；改成按格子的 90% 缩放、抖动 ±4% 就恒成立（0.45+0.04 < 0.5）。
- **多材质 GLB 想进「每实例一个颜色」的池子，就把材质色烘进顶点色**：一件道具往往有多个网格/材质，而本项目的实例化池用 `instanceColor` 做每实例染色（视野变暗就靠它）。若保留多材质，就没有单一的每实例颜色可写；若按网格拆池，draw call 会翻好几倍。做法是在加载时把每个网格的 `material.color` 写成该网格几何的 `color` 顶点属性、丢弃 uv/切线、合并成一份几何（`mergeGeometries` 要求属性集一致，所以统一转成非索引），再配一个 `MeshToonMaterial({vertexColors:true})`——顶点色 × 实例色，两个旋钮都保住了。**代价**：顶点色是烘焙的，道具不能再做「整体换色」之外的材质变化（本套件是平面色，没有损失）。顺带一条：**合并前必须清掉各网格不一致的属性**，否则 `mergeGeometries` 会直接抛错。
- **一条规则同时决定「画什么」和「打谁」时，它只能有一个定义，而且必须待在纯模块里**：玩家的「看得见」同时被两处消费——渲染层用它决定隐藏谁、变暗哪儿（`render.ts`），模拟层的**自动瞄准**用它决定锁定谁（`game.ts::nearestVisibleEnemy`）。做法是把谓词放进无 three / 无 DOM 的 `vision.ts`（`visibleWithReveal` = 近身或视线通畅），两边都 import 它。于是「屏幕上的敌人 == 能锁定的敌人」是结构性事实：既不会出现准星跟着看不见的目标走，也不会出现屏幕上有敌人却锁不上。**反例（要避免的形态）**：渲染层写一套 `lineBlocked`、模拟层另写一套「距离够近就算看得见」——两份近似各自都合理，合起来就是玩家看得见的谎。**推论**：一个「只做渲染」的系统一旦被玩法引用，它的谓词就不再属于渲染层，应该搬进共享的纯模块（本例只搬谓词，变暗几何仍留在渲染侧）。
- **给共享谓词加过滤时，先确认「极值 + 过滤」的判定顺序**：`nearestVisibleEnemy` 把可见性过滤放在「取最近」的循环**内部**（只对已经比当前候选更近的敌人才花那次线段查询），所以它返回的是「可见者之中的最近」，而不是「先取几何最近、再看是否可见」——后者会让一个更近但被挡住的敌人把合法目标挤掉。这类循环要写成「先比较 → 再过滤 → 再赋值」三段，顺序错一个位置就是另一种语义。
- **动手改玩法判定前，先看一眼行为快照的隔离方式**：给自动瞄准加视野过滤属于玩法改动，`trace-shooter.mjs` 却逐字节不变——因为它的场景都执行了 `sim.obstacles = []`（关卡数据不属于快照）。这既是好消息（证明改动没有额外副作用）也是提醒（**快照证明不了关卡相关的行为**，那部分要靠 `verify-vision.mjs` 这类带真实布局的断言）。**反过来的坑（本轮踩到）**：改了一条**现有场景走不到**的分支时，快照同样不变，于是「没有 diff」会被误读成「模拟层没改」——对策是补一个能走到它的场景（见上文 §10 基线一节的场景 ⑤），而不是靠人记住这件事。
- **限定范围的辅助/自动逻辑：参照物绝不能是上一帧自己的输出**（开火辅助的 15° 锥）：直觉写法是「朝当前瞄准方向 ±15° 内找最近的敌人」，而如果这个「当前瞄准方向」在锁上之后被写成了目标方向，锥体就会**逐帧向目标爬**——16° 的敌人第一帧在外面，但朝向被推到 15° 之后它就在里面了，下一帧再推到 14°……最终锁上任何东西。正确做法是把参照物钉死在**本帧的外部输入**上（这里是相机朝向 `input.aim`，由玩家控制、不参与反馈），于是辅助成为「本帧输入 → 本帧方向」的**纯函数**：可以断言（`verify-vision` 有一条「28° 目标按住 2 秒仍锁不上」的反向用例），也不会出现「松手后视角自己漂」。**通用形态**：任何带阈值的自动行为（自动瞄准、自动索敌、摄像机避让、寻路转向平滑）在写之前先问一句——「这个阈值比较的两个量里，有没有一个是本系统上一帧写过的？」有，就要把它换成外部参照或加显式的迟滞状态。
- **「视觉即伤害范围」——特效必须和判定共用一份数据，否则会画出玩家看得见的谎**：RPG 的冲击环半径等于 `ROCKET_BLAST_RADIUS`（阻尼粒子的总位移 ≈ `speed/drag`），而且是**由半径派生**的：`spawnExplosion()` 里 `S = ROCKET_BLAST_RADIUS / 3.5` 乘到所有尺寸、速度**和冲击环的颗粒数**上，`config.ts` 的 `blast*` 只保留"原始 3.5 单位爆炸"的参考值。第一版是手工把 `blastRingSpeed` 调到"刚好等于半径"，火箭从 3.5 涨到 5.25 时所有特效数字都会集体过期（而屏幕上只表现为"有点怪"）——**凡是"两个数必须相等"的约定，都应该让其中一个由另一个算出来**。颗粒数也要乘：环的周长变长而颗粒数不变会变成明显的串珠。注意**高度与垂直速度不参与**缩放（它们是对着 2 单位高的角色和地面调的，与爆炸半径无关）。近战新月沿用同一条规矩：半径从 `slashRadiusStart` 外扩但**正好停在 `reach`**；而且新月自身有宽度，所以扫掠起点必须**内缩一个新月宽**，才能让「扫掠并集 = 伤害锥」而不是起手把拖尾甩到锥外。这些都被断言：外缘半径终点精确 =1、两条边缘在采样全程都在锥内、并集的两个端点精确落在 `aim ∓ half`。
- **一次性动画不能靠「每帧调 `play()`」驱动**：`CharInstance.play()` 对同名调用直接 `return`（这正是它实现交叉淡入的方式），所以每帧调用会把动画**钉在第 0 帧**。正确做法是模拟层给出**单调计数**（`Player.swingCount`），渲染层做**边沿触发**重播——比在渲染层轮询 `swingT` 的「0 → >0」更稳（那种写法在动画窗口内再次挥砍会漏掉）。配套两点：`play()` 需要 `restart` 分支才能真正倒回第 0 帧；`restart` 时只在 `prev !== next` 才 `fadeOut`，否则对同一个 action 先 fadeOut 再 reset+fadeIn 会留下两条互相打架的权重曲线。
- **断言值落在自己容差边缘的测试是抽奖：测不变量，或者用实测分布定带宽**：爆炸冲击环有一条 `|maxR - ROCKET_BLAST_RADIUS| <= 0.2`，看起来完全合理，实际是**约 1.3% 概率红**的 flaky 测试（300 次实测：最大半径 5.022–5.113，R = 5.25，边界正好切在 5.05 上；全量跑套件时真的红过一次，差点被当成相机改动的回归）。根因是它拿「有限寿命内画出来的半径」当成「终端半径」：粒子在指数尾巴收完之前就死了（只有 ~96%），而且每个粒子的速度带 ±8% 的 `Math.random()` 抖动——**模拟层用 `Math.random()`（不是种子化 PRNG）时，任何对轨迹取 max/min 的断言都天然是抽奖**。修法是把「设计意图」和「实测表现」分开：① 用纯常数断言终端半径（`blastRingSpeed × S / blastRingDrag` ∈ 伤害半径 ±10%，一个随机数都不碰）；② 画出来的值用一个**由实测分布定出来**的带宽（93%–103%）兜住。这与 `verify-burn.mjs` 里余烬那条的历史注释是同一个教训（「跟踪 `embers[0]` 是对 RNG 流抽奖」）。**推论**：新增带随机的断言前，先跑 200–300 次把分布量出来，再定边界。
- **看起来「不好验证」的特效，把数学和顶点数据搬进纯模块**：加色混合 + 无贴图 + 无自定义着色器时，新月的软边只能靠顶点色烘焙——而烘焙错了在真机上只表现为「有点怪」。所以顶点生成（径向软边包络 × 角向包络）和扫掠曲线都放在**不 import three** 的 `slash.ts` 里，`verify-melee.mjs` 直接断言两端包络为 0、角向包络单调、外缘半径精确为 1、无 NaN，以及**渲染层的 `rotation.y = -angle` 约定把刃口送到 `slashAngle` 而不是镜像到另一侧**——这个符号错误在模拟层完全测不出来，但会让每一刀都劈在背后。
- **缓动曲线的方向决定了「有没有力量感」（真机反馈踩过）**：近战扫掠第一版用 smoothstep（缓**入**缓出），真机反馈「速度太慢、没有力量感」——问题就出在**起步那一段是慢的**。重武器不会先慢慢加速再挥出去，而是**出鞘即最高速、然后用余程减速收势**，所以改成 `1-(1-u)^k`（k=`CONFIG.slashEase`，当前 3：前 1/4 时间走完 58% 弧、半程 87.5%）。教训是通用的：**「平滑」不等于「有力」**，ease-in 适合「蓄力」的表现（拉弓、起步加速），ease-out 才是「打击感」（挥砍、弹射、UI 弹出）。曲线形状现在由断言钉住（前倾、三段斜率严格递减、k=1 退化为线性），改回 smoothstep 会立刻测试失败。
- **挂在移动角色身上的持续特效，锚点必须每帧跟随（真机反馈踩过）**：`SlashFx` 一开始只在生成时快照了攻击者坐标，于是真机反馈「特效会留在原地没有跟着角色走」。新月是**角色手里那把刀**的拖尾，判定只要算一次但**渲染要跟着人走**：`playerSpeed=11` 时 0.17s 已经走了约 1.9 单位，和 `reach=3.4` 同量级，冻结坐标肉眼可见。修法是渲染读的 `x/z` 每帧同步角色位置。**但要区分两类状态**：新月本体跟随，它**已经甩出的气流粒子必须留在世界空间**（那是运动拖尾的物理事实，跟着走反而假）——所以 `spawnSlashStreak` 把粒子写进世界坐标后就不再管它们。同类情形：任何「一次生成的持续特效 + 移动施法者」（地面火焰、护盾环、激光）都要先想清楚哪些部分跟随、哪些留在世界。

- **场地尺寸不是一个可以随便改的常量：它会改写「同屏弹丸」「life 是不是保险」这类被断言保护的结论**：近战波次改掩体射击时把 `ARENA_HALF` 从 20 抬到 38，`verify-ammo.mjs` 立刻红了两条 —— 弹丸在 `|pos| > ARENA_HALF + 2` 处被清除，而 40x40 时「一次齐射在 0.6s 冷却前出界 → 同屏 ≤ 8」这个结论是**地图的性质，不是武器的性质**。76×76 下居中一次齐射要飞 0.635s，同屏变 16（贴一侧打对面 24）。更隐蔽的是 `life`：`flameShot.life` 1.1s = 69 单位、`smgRound.life` 0.4s = 40 单位，都短于新的最坏飞行距离（~77 单位），弹丸会**在半空因寿命消失**，而那两处注释还写着「life 只是保险」——注释变成了假话。教训：**放大场地时要把所有由场地派生的数字一次性重算并写进断言**（本例新增了 4 条：出界时间 ≈ 边界飞行时间、飞行时间短于 life、居中峰值 = 16、最坏 = 24），否则它们会静默漂移。
- **阴影相机是固定正交盒，地图变大就必须让它跟着人走**：`DirectionalLight.shadow.camera` 是一个固定在原点的 ±30 盒子（配 2048 贴图）。40×40 时它盖住全场；76×76 时四角**直接没有影子**（有光无影，物件看起来像贴在地上的贴纸）。把盒子放大到 ±40 可以让它重新覆盖，但同样的 texel 摊到 78% 更大的面积上，全场阴影一起变糊。正确做法是**每帧把光源和 target 一起平移**（保持常量偏移 ⇒ 光照方向不变，只有盒子在动），texel 密度和覆盖范围同时保住 —— 这正是相机已经在做的事。**同类坑**：任何"范围写死的正交相机/阴影盒/雾/后处理区域"都隐含一个世界尺寸假设。
- **碰撞把实体停在"刚好贴面"的位置，所以线段查询必须留 skin**：`circleAabbResolve` 把「贴面」定义为不重叠（否则贴墙站立的实体会每帧被推一下，肉眼看就是抖）。于是玩家贴着墙时坐标**恰好落在墙面上**，而此时如果用精确的线段-AABB 判定，`t = 0` 会被判成"已命中"——**顺着自己靠着的墙开枪会打掉自己的子弹**，靠在墙上的枪手会认为自己永远没有视线。修法：线段类查询（子弹/视线）把掩体**收缩 1cm**（`level.ts::SEGMENT_SKIN`），贴面掠过算未命中、真正穿入仍算命中。1cm 远低于任何有意义的厚度（本关最薄掩体 1.6 单位），也远高于浮点噪声。
- **「爆炸落在墙面上」会让视线判定变得歧义，解法是把爆心沿来向回退而不是调 epsilon**：火箭撞墙时命中点**正好在墙面**，而以它为起点做视线查询，slab 法无论线段随后是穿进墙还是离开墙，都返回 `t = 0`。想用 epsilon 区分"起始即相切"和"起始即穿入"是徒劳的（那正是上一次坑里的同一个边界）。把爆心沿**子弹来向回退 0.1 单位**（`rocket.onHit`）就同时解决了两件事：它明确落在墙的**近侧**，于是"墙前吃溅射、墙后安全"自然成立，不需要任何阈值微调。
- **无敌帧就是承伤上限，别再加"同时开火人数"这类节流**：玩家中弹会拿到 `contactInvuln`（0.6s），敌人子弹**共用同一个计时器**，所以任意数量的枪手在数学上都无法超过 `damage / 0.6` 每秒。设计一队枪手时这条比任何节流都简单且可断言（`verify-gunner.mjs` 用三名枪手同帧开火，断言 0.6s 内只扣一次血；并用长窗口断言总承伤不超过理论上限）。**它也是"敌人连发"能安全上线的原因**：把枪手从"一发一歇"改成打空一梭子，提高的是**实际**承伤（不再有 3s 空档可走），而上限本身没动——所以这类改动不需要新的伤害数字，`verify-gunner.mjs` 反而会断言实测承伤**被推向**上限。**顺带**：`invuln` 也要像 `swingT` 一样**夹到恰好 0**——浮点倒计时会停在 ~-1.7e-16，而全代码都在用 `> 0` 判断，一个"已经结束"的计时器必须读作 0。
- **AI 的走位参数要读实体字段，不要直读 CONFIG**：枪手最初在 `updateGunner` 里直接读 `CONFIG.gunnerSpeed`，于是 `Enemy.speed` 形同虚设——测试想把某个敌人钉住（`speed = 0`）来做隔离实验都做不到，等于这个字段撒了谎。同类：任何"每实体参数"在行为代码里都必须从实体读，实体由工厂从 CONFIG 初始化。
- **「拖拽/长按」类手势的输入要写成 `(锚点, 读数)` 的纯函数，不要每帧累加**：视角区（右下的透明触摸矩形）控制相机 yaw 时，直觉写法是 `yaw += dx * 灵敏度`。它有两个毛病：① 浮点误差逐帧累积，同一个手势在不同帧率下落点不同（`dx` 被采样几次就加几次）；② 竞态——面板改灵敏度、屏幕旋转、手指抬起再按下，都会让"当前值"依赖历史，无法在 node 里复现。现在改成**按下时记录锚点**（`input.ts::yawAnchor`），运行时只是 `stickYawTarget(锚点, 读数.x, 灵敏度)`（`camera.ts`，纯函数、可断言），所以手势的落点只由「按下时在哪」和「推了多远」决定，与帧率、与历史无关。代价是**松手要明确决定行为**——这里选的是冻结（保留视角），不是回弹；两种都是对的，但必须选一个并写下来。**同一个模式的另外两处**：`mouse`/`touch` 的位置瞄准被整体删除（它是"每帧读当前状态"的另一种形式，与"角色永远朝相机前方"直接冲突），而 `stick.ts::axisLockOffset` 把「只读一个轴」变成**看得见**的约束（knob 也锁在横轴上）而不是默默忽略另一个轴。**连锁反应也值得记一笔**：`game.ts` 的朝向条件从 `if (hasAim && p.firing)` 变成 `if (hasAim)`，于是**朝向 = 视线 = 弹道**成为同一个向量，走路不再转向移动方向、近战挥砍方向也等于视线——这不是 bug，是这套操作的必然结果，但它会**改变行为快照**（见上文 §10 的基线一节：只有场景 A 的 40 行变了）。
- **方向约定必须写成断言，不能只写在注释里**：视角区第一版是 `yaw = 锚点 + 读数 × 灵敏度`，代码、注释、单测三者自洽，**真机反馈却是「右摇杆操作反向」**——因为 `ψ` 的正方向（相机移向玩家 +X 侧）在屏幕上看是**世界向左转**，`+` 恰好是反的。修法是把符号收进**一个纯函数** `camera.ts::stickYawTarget`（`锚点 − 读数 × 灵敏度`），并把断言从「等于某个数」改成**用方向说话**：`stickYawTarget(0, 1, 90) === -90` 这条的测试名就叫「右推 = 视角右转」。桌面拖动复用同一条规则（`lookYawFromPixels`）——**两个入口一个符号**，否则手柄和鼠标会各自"对"一半。教训：手感类符号（旋转方向、轴向反转）**要么有一个可断言的语义名，要么就会在真机上翻车**；`+`/`−` 本身不是可评审的信息。
- **大面积隐形触摸层必须比它可能盖住的东西更低层**：视角区是一块透明矩形，尺寸由视口推导（能盖住左摇杆与开火键），而它**必须输掉每一场**与那些控件的竞争。做法不是"把它做小"，而是**z-index 5 < `.stick` 的 6**（并低于按钮的 7/8/25）：低层元素收不到已经落在高层上的指针，所以一块巨大的隐形矩形吃不掉移动摇杆——这是**结构性**保证，不依赖尺寸算得准。同一套思路的两条推论：① 它只在设置面板打开时显形，而"打开"这个状态要有一个可断言的载体（`<html>` 上的 `settings-open` 类，`verify-panel` 断言它随面板开合），不要靠 `:has()` 之类难以在 DOM shim 里驱动的东西；② 显形时它被抬到面板之上（z-index 40），但**同时 `pointer-events:none`** —— 看得见 ≠ 可点，否则 368×168 的隐形矩形会把面板右半边变成拖拽区。
- **原点要跟着输入的语义走：固定底座量中心，滑动面板量落点**（真机第二轮 bug「每次按右边区域都会有朝向跳变」）：左摇杆是**固定底座**，偏移量必须从元素中心算（玩家看着那个圆盘推）；视角区是一块**大面积透明矩形**，如果也量中心，那么"按在偏心处"这**一个动作**就已经是一次大偏移（实测按在离中心 90px 处 = 满偏），于是每次触摸都让视角瞬间跳到某个角度。修法是把"零在哪里"变成显式概念（`stick.ts::StickOrigin`：`'centre' | 'press'`），落点模式下按下那一刻把原点设成落点，读数**恒为 0**（`verify-stick` 断言任意落点都是 0，`verify-panel` 用 DOM shim 驱动真实 `Input` 断言偏心按下不改 yaw）。三条连带结论：① **行程不能再由元素尺寸推导**——底座不再是元素，`travelForSize(width)` 失去意义，落点模式用固定的 `PRESS_TRAVEL_PX`（90px），保证同一个手势在横竖屏、任意区域尺寸下含义一致；② **圆球要一起删掉**——球的意义是"显示底座在哪、被推到哪"，而落点锚定的控件没有可显示的底座，画一个只会让人以为存在固定中心（CSS 规则与 HTML 元素两侧都加了「不存在 knob」的断言，否则会留下一颗孤零零的点）；③ **桌面拖动本来就是这个语义**（拖动从按下的位置算），所以两套输入现在共用一条规则，不再需要解释为什么鼠标和触屏不一样。
- **方向光的阴影盒要「按视野拟合 + 吸附整 texel」，不能写死、也不能跟着玩家的浮点位置走**：本项目的室内美术把阴影边缘从「几十条」放大到「几百条」之后，两件原本看不见的事同时暴露：① 盒子中心每帧跟着玩家移动零点几个 texel，纹素网格就每帧落在新的世界位置，**静止几何被反复重采样**，房间里每条阴影边缘都在爬（实测旧盒子每帧有地面采样点的 0.65% 变明暗，新盒子 0.00–0.01%）；② 写死的 `±30` 在视野更宽/相机更高时**漏掉屏幕内的地面**（实测最坏漏 7%，且盒子边界随玩家扫过屏幕 = 阴影忽有忽无）。修法见 `apps/shooter/src/shadow.ts`：**大小**由相机视锥决定（并且必须用**未裁剪**的视锥方片，否则墙一裁范围就变、texel 尺寸会呼吸、网格重新对齐），**中心**吸附到整 texel（亚 texel 位移给出逐位相同的网格），`bias/normalBias` 由 texel 尺寸推出而不是硬编码。两个真实踩过的细节：`|x| ≤ H` **不是半平面**，拿它做 Sutherland–Hodgman 会把多边形裁空（3.0× 取景下拟合出 NaN，整台阴影相机直接坏掉）；而「拟合盒子的中心」要用**裁到场地之后**的中点，「大小」要用**未裁剪**的范围。**并且**：这类"只在真机上看得见"的问题不能靠猜——`scripts/verify-shadow.mjs` 用一个 2048² 的正交光栅器 + 逐 tap 复刻的 PCF-soft 核，在 node 里把真实的 769 个实例画进阴影图，与 vendor three 的 `light.shadow.matrix` 逐点对照，并直接量出「每帧翻转率」和「空白探针的自阴影噪点率」。**顺带纠正一个诊断**：这次的噪点**不是** acne——孤立薄板探针在旧常数下也是 0.00%（three 的阴影 Pass 用背面投影，薄板的背面天然提供了比 `bias` 更大的深度余量）。诊断必须靠测量，不能靠公式直觉。
- **「平均/总体」够了的断言，会让个别对象烂到底**：掩体的家具填充率原来只断言**总体** ≥ 35%（当时实测 42%），于是「一个 4×4 的碰撞盒里只有一件小凳子、占自身脚印 2%」这种掩体一直绿灯——而玩家看到的恰恰是它：「这些障碍物都太小了」。**总量合格与逐项合格是两件事**，尤其是当玩家一次只会盯着一个对象看的时候。现在 `verify-props.mjs` 逐掩体断言覆盖率 ≥ 40%、至少一件到胸口高、一堆不超过 14 件（并且把 `COVER_TALL_H` 导出成断言的一部分，而不是让测试抄一个数字）。**同一个教训的另一半**：摆放算法原来按「形状」分池（长条/方块/墙），其中一支的判据是 `long && !wide`——**同一个形状横放和竖放会拿到不同的家具**，实测同房间里的 3.4×19 长墙竖着只有 15% 覆盖、横着 56%。**朝向不是设计变量**，同样的盒子就该配同样的家具；池子现在按「房间功能」（客厅/厨房/书房/卧室）分，并且分类只作为**覆盖率之后的偏好**（只在本类里挑会把覆盖率打到 28%，房间反而更小）。
- **量资产要量「加载器画出来的东西」，摆资产要保证原点真的在脚印中心**：`PROPS` 里的尺寸是所有「视觉不超出碰撞脚印」证明的输入，而 glTF 网格的 POSITION accessor 边界是**网格局部空间**的——加载器还会套上节点层级的 TRS。这套 Kenney 件有 11 个文件的节点带真实变换（`plantSmall*` accessor 画大 2 倍 / 节点缩 0.5 倍，`bedDouble` 子节点带旋转，冰箱带 0.66 倍缩放），所以**量 raw accessor 得到的是没人画过的尺寸**：垃圾桶与床被高报 2 倍以上（规划于是把它们缩得很小），冰箱进深被低报 5%（低报是最坏方向：真实几何伸出碰撞盒）。同一类错误还出现在**原点**上：这套件的原点大多在**脚印的角上**（`floorFull` 占 x 0..1 / z -1..0），还有 3 个模型沉在地面以下，而摆放数学假设「实例位置 = 脚印中心、底面贴地」——实测 **89/222 个掩体道具伸出碰撞盒**（最远 0.95 单位），并且所有地板瓦片带着同一个偏移，**铺出来的地板整体偏了 2 个单位**，沿两侧墙留下一条 2 单位宽的裸地。修法是让「量」和「摆」共用同一个公式（`props.ts::propNormalizeOffset()`，加载器 `assets.ts::normalizeProp()` 用它平移几何，`scripts/lib/glb.mjs` 用它平移测量，`verify-props.mjs` 断言两端一致）。**教训**：「按 A 假设摆放、按 B 数据验证」的系统两边都自洽也不会报错，只会安静地画出错的东西——**包含性断言必须建立在"加载器真正画出的几何"上**。
- **可见多边形的角点角度必须和射线测试用「同一个盒子」**：掩体的线段查询为了 skin 会把盒子**收缩 1cm**（见上一条）。视野扫描一开始按**原始 footprint** 取角点角度，而射线却打收缩后的盒子——两者的角跨度差了一个 skin 的角宽，于是跨在那个角上的扇区从「23 单位处命中」线性插值到「130 单位处不命中」，**泄露出一片几十单位宽的假可见区**（玩家能看见本该被挡住的敌人）。修法：角点坐标用 `o.x ± o.hw - pad` 与射线测试完全一致地展开。教训是通用的：**扫描/采样用的几何定义必须和查询用的几何定义同源**，差一个 epsilon 就会在最敏感的地方（剪影边缘）放大成灾难。它由 2.3 万点的网格交叉验证抓出来（`verify-vision.mjs`），这也是"把纯数学搬进可断言模块"的价值所在。
- **乘性混合（`MultiplyBlending`）会经过输出色彩空间变换，所以"变暗"要用逐顶点 alpha**：想给一块区域压暗，直觉是黑材质 + 乘性混合，或者写一个 `0.35` 的顶点色当乘数。但 three 的渲染管线会把材质颜色从 working(linear) 空间编码到 sRGB 输出，**你写进去的数不是你屏幕上得到的倍数**（想得到乘 0.35，得写 `srgbToLinear(0.35) ≈ 0.1`）。正确做法是**黑色材质 + 普通混合 + 4 分量顶点色的 alpha**：`dst *= (1 - alpha × opacity)`，alpha 不参与色彩空间变换，滑杆的值就是"变暗多少"。实现前先确认 vendor 的 three 支持逐顶点 alpha（r169 里是 `vertexAlphas: vertexColors && color.itemSize === 4`）。**顺带**：同一段几何里"软边"用顶点 alpha、"整体强度"用 `material.opacity`，两个旋钮正交，比把强度也烘进顶点色好改。**再顺带一个推论**（射击子应用的暗角就是乘性混合）：乘性混合的对象是**帧缓冲里的那个值**，所以它必然会受"离屏那一遍的缓冲是线性还是 sRGB"影响——这正是上面那条「中间 target 的合成色彩空间」要解决的问题（实测线性缓冲下角落的压暗量会弱 30%+，改成 display-referred 之后两条路径逐位一致）。凡是屏幕空间的加法/乘法混合，都要先问一句"我在哪个空间里乘"。
- **`depthTest:false` 的世界空间 UI 会击穿任何视野/遮挡系统**：敌人血条为了让被角色挡住的条还读得出来而关掉了深度测试，代价是它会画在所有东西之上——包括新加的黑暗。于是"隐藏敌人"这个功能必须**显式**把它们一起门控（血条、瞄准预警光束、子弹的点光源都是同类泄露通道，只隐藏角色模型是不够的）。通用检查项：任何新加的 billboard / 描边 / 名字牌 / 血条，都要问一句"它在视野外会不会仍然可见"。
- **three 里 `visible = false` 同时也把物体移出阴影 Pass**：这既是好事也是约束。好事：隐藏一个敌人不会通过"地上少一块影子"泄露位置（否则"隐藏"等于没做）。约束：如果哪天真要改成"压暗而不是隐藏"，这条便利就消失了，必须自己处理影子。
- **卡通渲染下的「环境光」只有半球光是那个环境项，削弱它才等于提高对比**（射击子应用真机反馈「能否削弱环境光」）：`MeshToonMaterial` 把**方向光**的漫反射过一遍梯度贴图（`RE_Direct_Toon` → `getGradientIrradiance`），所以方向光**抬不起背光面**——它只能把受光面推上更高的台阶；而 `HemisphereLight` 走的是**间接**辐照，卡通着色器**不给它分档**，是一层**与法线无关的平铺光**。这层平铺光正是"环境光"的字面含义：它抬高暗部地板、压掉明暗动态范围，于是画面发平。**推论**：① 想提对比/加气氛就削半球光，**不要**"顺手把方向光也调暗"（那只是把整张画均匀压暗，对比不会回来）；② 任何以「亮度/曝光」为名的调参，先问一句"这个参数在 toon 管线里走的是分档路径还是平铺路径"。**落地方式**：数值搬进纯叶子模块 `apps/shooter/src/lighting.ts`（基色/基强度 + 倍率的范围与钳制），因为它是用户设置项，而 `settings.ts` 必须保持无 three、可 node 测试；渲染侧只留 `render.ts::addLights()` 建灯与 `setAmbientScale()` 一个写入口。**顺带一条设计经验（而且是踩过一次的）**：削弱观感时要把**滑杆顶端定成"正好回到旧观感"那一档**，这样它就从一次不可回退的改动变成用户随时可回退的一格——这在本环境没有浏览器、只能靠真机眼睛验收时尤其值钱。**但顶端必须"推导"，不能"写死"**：第一版写死 `AMBIENT_SCALE_MAX = 2.5`（对当时的基强度 0.42 恰好等于 1.05），而下一轮用户要求"降到现有值的 1/3"（基强度 0.14）时，那个写死的 2.5 只到 `0.35` —— **比刚刚被下调的 0.42 还暗**，用户连"撤回上一次下调"都做不到，而库里所有断言、注释和文档都还在说"顶端 = 旧值"。现在 `AMBIENT_SCALE_MAX` 由 `AMBIENT_LEGACY_INTENSITY / AMBIENT_BASE` 推导（取整到步长），"顶端回到旧观感"变成结构性事实，改基强度再也不会悄悄缩小可回退范围。**通用规则**：当一个常量是"为了让某个不变量成立而选出来的"，就把它写成那个不变量的表达式；手写的数值只在这条不变量被删掉的那天才是对的。**同一条经验还适用于"读数"**：环境光滑杆的显示值锚在**设置项出现前的 1.05**（`ambientPercentOfLegacy`）上，而不是锚在"当前基强度"上——因为基强度在四轮里被改了四次（1.05 → 0.42 → 0.14 → 0，出厂默认最后落在 0），若读数锚在基强度上，用户上次看到的"40%"这次就会变成别的亮度，历史截图和文档里的数字全部失效。**参照物要选那个"产品含义上不变"的量**，哪怕它已经不是当前的实现值。另外记一笔同类区分：三盏灯最后变成了**两把旋钮**（环境光/方向光），而不是给每盏灯一把——补光的比例是"形体"信息，等比缩放才叫亮度，单独动一盏改的是冷暖比，那是另一个需求，应该新增键而不是拆现有键。**连带一条跨系统经验**：同一个子应用里两个都作用在"亮度"上的设置项会**互相稀释**——遮挡变暗是一层固定不透明度的黑，环境光压低后可见区的底色也变暗，于是"亮 vs 暗"的对比反而变小；类似地，加色混合的弹丸点光源在更暗的地面上会更抢眼。调其中一个时要把另一个一起看一眼，别把它们当成彼此独立的旋钮。
- **星形可见多边形的补集可以直接三角化，不需要 earcut**：可见多边形的每个顶点都由**同一点**沿射线射出（星形域），所以每个角扇区**在边界之外的区域恰好是四边形**（边界弦 + 最远环）。这意味着"把被遮挡的区域涂黑"可以用一段纯手写的三角形列表完成：不需要 earcut、不需要挖洞三角化、不需要自定义 shader，而且**没有遮挡时三个环重合 = 零面积 = 什么都不画**。同类几何（战争迷雾、扇形视野、探照灯）都可以先问一句"它是不是星形的"，是的话就省掉一整个三角化依赖。
- **验证设置写入前必须先备份 `data/settings.json`**（本次真实踩到）：`PUT /api/settings/<scope>` 是**整包替换**该 scope，不是补丁式合并。为了验证「视野键能存能读」而发一个只含测试值的 PUT，就把真实设备上存好的 `stick.sizePx` 与 `camera.heightScale` 一起覆盖掉了（用户数据不可恢复，只能按记录的两个数值手工写回）。正确做法：`cp data/settings.json /tmp/settings.bak`（或用 `GET` 把原值抓下来）→ 做写入验证 → 用备份**原样**写回，再 `GET` 确认。**任何「验证写入」都应该先问自己一句：这是不是别人的数据？**
- **给蒙皮模型加「导出缩放」不能套一个父节点——缩放在成品 glTF 的 JSON 上加才对**（FBX→GLB 子应用的真实坑）：`GLTFExporter` 写出的 inverse bind matrices 是 `skeleton.boneInverses[i] × object.bindMatrix`，而顶点数据与骨骼层级保持原数值。于是「在输入外面包一个 `scale` 的 `Group`」会同时改到两处：蒙皮数学看到的是被缩放过的骨骼世界矩阵，节点变换里又有一份缩放——**1.6 单位的模型导出 ×0.01 后量出来是 0.00016（缩了两次）而不是 0.016**。正确做法是导出完成后再动 JSON：给 `json.scenes[0].nodes` 加一个 `{ scale:[s,s,s], children:[原根] }` 的包裹节点（二进制路径 = `readGlb` → 改 JSON → `writeGlb`，BIN chunk 一个字节不动）。**为什么这样是对的**：整棵图统一缩放时，关节矩阵与绑定矩阵处在同一空间，每个蒙皮顶点恰好乘一次。**推论**：任何「导出后再统一变换」的需求（缩放/旋转/居中）都应该问一句"我改的是节点还是数据"，并优先选**不改 exporter 输入**的那条路。
- **`Box3.setFromObject()` 对 `SkinnedMesh` 会把世界变换算两次**（同一个子应用里被上一条的断言抓出来的第二半）：three r160 的 `SkinnedMesh` 自带 `boundingBox` 缓存，而 `SkinnedMesh.computeBoundingBox()` 是通过 `getVertexPosition()`（即 `bone.matrixWorld`）算的——**结果已经是世界空间**；`Box3.expandByObject()` 随后又乘了一次 `object.matrixWorld`。层级为单位阵时完全看不出来（这正是它一直没被发现的原因），一旦有缩放/平移就把尺寸量成 `scale²` 级别：1.6 的模型量出 0.00016，正好毁掉「单位对不对」这个问题本身。**规避**：要「模型画出来多大」就自己遍历 `geometry.boundingBox × object.matrixWorld` 求并集（本仓库 `apps/fbx2glb/src/analyze.ts::measureSize()`，也是射击子应用 `normalizeModel()` 用的口径），并且**在断言里同时钉住"未缩放的高度"与"缩放后的高度"**，否则这类只差一个幂次的错误在单点断言下永远是绿的。
- **子应用的 vendor 宁可重复也不要跨应用共享**：`apps/fbx2glb/vendor/` 与 `apps/shooter/vendor/` 各持一份逐字节相同的 three r160（670KB × 2）。这是刻意的：子应用之间没有任何依赖，删掉一个不会带走另一个的运行时；共享需要动 `scripts/build.mjs`（把 `vendor/` 提到根目录），那是一次平台层改动 + 全套回归，**为一个拷贝付这个代价不值得**。代价写明：升级 three 要改两处（验证脚本会断言两份 md5 相同，漏掉一处就红）。
- **`session/agent-busy` 这个名字会骗人（顺带记一笔）**：dsh 的 `prompt rejected` 兜底文案挂在 `session/agent-busy` 这个 code 上，实际含义是「附件 admission 抛了非 RemoteError / 非 AttachmentError 的异常」。本项目无关，但排查 DSH 报错时别按「agent 忙」去想。

---

## 11. 命令速查

    npm install          # 安装 devDeps（typescript + @types/node）
    npm run build        # 原子构建：编译到 dist.next/ 再换入 dist/（失败不动 dist/）
    npm run dev          # ★ 日常开发用这个：构建 + 启动 + watch 源码，保存即重建重启
    npm start            # 直接启动已构建的服务器（不 watch，改源码需重启）
    npm run launch       # = npm run build && npm start

**环境变量**：`PORT`（默认 3000）、`HOST`（默认 0.0.0.0）。例：`PORT=8080 npm start`。

**无后端依赖地验证（构建后）**：下面是**常用脚本清单**（列出的这些各自证明什么；完整清单见上面的文件树与各应用 README），**不是「每次改动都全跑」的门禁**——按改动范围挑（政策见 `AGENTS.md` §启动与验证 第 6 条，映射表在对应应用的 README，如 `apps/shooter/README.md` 的「改动 → 跑哪个脚本」）：

    node --check dist/shell/main.js
    node scripts/trace-shooter.mjs        # 射击子应用行为快照（重构前后 diff 必须为空；先 npm run build）
    node scripts/verify-stick.mjs         # 摇杆几何 + 相机取景几何（含 0.4/3.0 两端）+ **偏航几何（cameraEye/cameraBasis/screenToWorld）** + **视角区输入（锚点/灵敏度/±180 回绕/「右推=右转」方向断言/桌面拖动同向）+ 落点即原点 + 固定行程 + 横轴锁 + 视角区尺寸（lookPadSize）+ 开火键位置** + 六组设置默认值/钳制/稀疏覆盖 + 相机两键 + 光照两键 + 雾 + 后期三键（tone 1 / vignette 0.7 / pixel 2，0 = 未处理/关闭）（215 项断言，退出码非 0 即失败）
    node scripts/verify-panel.mjs         # 设置面板 + 武器/开火按钮 DOM 接线（DOM shim：**满屏分页结构**（固定头/固定页签/唯一滚动体、✕ 在头部第一个、六页六签与切页、隐藏页仍生效、摇杆页两列）/15 个滑块（含相机水平角度与灵敏度）/八个回调/组级重置/**视角区显形开关与 CSS 变量**/**用同一个 shim 端到端驱动真实 `Input` 验证「偏心按下不跳变」**/开火键拖拽放置/pointerdown 接线 + **styles.css 源码级断言**（inset:0、[hidden] 显式 display:none、横屏不再覆盖面板字号、两列 grid、`.fire-btn.placing`、视角区平时透明且 z-index 低于摇杆、只在 `html.settings-open` 下显形且 pointer-events:none、CSS 与 HTML 两侧都没有 knob），126 项断言）
    node scripts/verify-fog.mjs           # 高度雾：<project_vertex>/<colorspace_fragment> 锚点在 vendor three 里各只有一处 + 世界观感的注入点在 colorspace_fragment 左边且包在编解码之间 + 手写 sRGB EOTF 与 three 的 sRGBTransferOETF 往返 < 1/255 + 世界坐标公式与 three 的 worldpos_vertex 等价（含 instancing/batching）+ 缺锚点整体不补 + `Material.clone()` 丢补丁/留 userData 的实测 + 雾公式单调性/参考值/可见度上限（80 项断言）
    node scripts/verify-tone.mjs          # 同上 + 燃烧自发光（栈数→发光量的单调映射、「燃烧中的敌人亮过地砖」的度量）+ 调色的定义域与瞬时光源色相 + 世界观感的组装顺序（80 项断言）
    node scripts/analyze-tone.mjs         # 画面调性【报告，不是门禁】：逐表面屏上颜色/L*/饱和度、对比度/主色占比/色相分布/熵、7 组关键 ΔE，以及调色 OFF/ON 的对照与暗角系数
    node scripts/verify-postfx.mjs        # 像素化后处理 + 正交相机：块→target 的设备像素换算与钳制、相机对齐的稳定性（真相机投影 + 亚像素余数不变量）、NEAREST/离屏/单遍关闭的源码级不变量、**display-referred 离屏 target（覆盖 colorspace_fragment 为无条件 sRGB 编码、安装在 renderer 之前、blit 纯拷贝、target 不标 sRGB、背景色喂显示字节；断言暗角/遮暗/加色与直画路径逐位相同，并把线性 target 的偏差量留作回归守卫）+ vendor 四条假设 + 后坐力作为纯平移、**横竖屏像素密度等价性（同一 heightScale 下 世界/CSSpx 逐位相同、旋转不改变渲染 texel 数、`像素化 = 1` 在 2x 画布上是半分辨率渲染；per-orientation 覆盖与 camZoom 钳制这两条破坏路径按实测值钉住）**（59 项断言）
    node scripts/verify-burn.mjs          # 燃烧 DoT + 火焰粒子 + 六层爆炸特效 + **爆炸火光** + 火箭平衡/伤害剖面 + 朝向数学（85 项断言）
    node scripts/verify-ammo.mjs          # 弹夹/换弹 + 冲锋枪 + HUD 读数 + 龙息弹弹速 + **后坐力（每武器数值与排序、方向、衰减、脏数据、瞄准不变）**（武器定义/换弹时序/帧率无关/散布/同屏弹丸上限，119 项断言）
    node scripts/verify-melee.mjs         # 近战 180° 锥（含 ±90° 边界）+ reach 3.4 + AoE + 方向交替 + 快→慢力量曲线 + 新月跟随角色 + 几何软边包络 + yaw 约定（131 项断言）
    node scripts/verify-muzzle.mjs        # 枪口特效 + 瞬时光源系统：三把远程武器的分层配方与物理预设同源 + 「最长寿命 < cadence」不变量 + 单发实测（与弹丸出生点逐位同点/方向 = 瞄准方向/齐射只出一次）+ 冲锋枪星芒分布 + RPG 等角环与向后爆燃 + 光源衰减与「比曳光弹亮 ≥1.5×」+ 渲染接线的源码级断言（93 项断言）
    node scripts/verify-cover.mjs         # 掩体布局不变量（含洪水填充无死区）+ 圆-AABB 滑行解算 + 线段-AABB + 最近点数学 + 掩体挡子弹/刀/火箭溅射（46 项断言）
    node scripts/verify-vision.mjs        # 玩家视野：可见多边形与 lineBlocked 的 2.3 万点网格交叉验证 + 边界横向误差 + 门控公平性 + 自动瞄准的可见性过滤 + **开火辅助的 15° 锥（10°/14°/15.5°/20° 的边界、锥外更近的抢不走、停火回正、棘轮反向断言、锥内墙后不锁、弹道沿辅助方向）+ 叠加面逐三角形光栅化（89 项断言）
    node scripts/verify-props.mjs         # 场景美术：道具尺寸 vs 磁盘 GLB 实测（节点变换后；改名/抄错即红）+ 每个道具脚印居中/底面贴地 + 掩体道具不越出碰撞脚印 + 填充率 + 房间无缝 + 点缀 keep-out + 确定性 + 无死条目 + 地面主题覆盖色 + 逐掩体的覆盖率/高度/件数下限（43 项断言）
    node scripts/verify-shadow.mjs        # 主光阴影盒：矩阵与 three 一致 + 视野覆盖 100% + 亚 texel 不蠕动 + PCF-soft 的 acne/翻转率实测 + **偏航（基与 lookAt 相机一致、9 角度覆盖率 100%、yaw=0 逐位复现）**（22 项断言）
    node scripts/verify-gunner.mjs        # 枪手三档走位 + 原地站定 + 视线门控 + 预警→连发一梭子→换弹时序（发数 = 武器弹夹、梭内间隔 = 武器射速、梭间 = 换弹 + 预警）+ 武器复用负断言 + 同屏弹丸负荷预算 + 弹伤/无敌帧承伤上限 + 环形生成与配比（75 项断言）
    node scripts/verify-zoom-lock.mjs     # 外壳页面缩放锁（顶层 viewport meta + html/.appframe touch-action + iOS gesturestart + dist/ 同步，17 项断言）
    node scripts/verify-fbx2glb.mjs       # FBX→GLB 子应用（apps/fbx2glb）：真样例走真管线（FBXLoader 解析 → 合并 + 骨架漂移重定向 + 覆盖率门 → GLTFExporter 写 GLB → 容器/自包含断言 → GLTFLoader 读回自检 → 缩放只发生一次）+ 命名/单位/骨架匹配/设置 schema 的纯规则 + **「不上传」源码级断言** + **DOM shim 启动真实 `main.js` 走完整用户流程**（样例→转换→下载不联网→改设置只发一次 PUT→多文件与合并两种模式→恢复默认真的落盘）（258 项断言）
    curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/manifest
    curl -s http://127.0.0.1:3000/api/manifest
    curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/apps/notes/
    curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/apps/fbx2glb/            # FBX→GLB 子应用
    curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/apps/fbx2glb/assets/sample.fbx

**设置 API（持久化）验证**：

    curl -s http://127.0.0.1:3000/api/settings                      # 整个存储
    curl -s -X PUT -H 'Content-Type: application/json' \
         -d '{"camera":{"landscape":{"heightScale":1.35}},"stick":{"landscape":{"sizePx":96}},"vision":{"portrait":{"dim":0.3}},"light":{"portrait":{"ambient":3,"directional":1.2}},"fog":{"landscape":{"density":0.03}}}' \
         http://127.0.0.1:3000/api/settings/shooter                 # 写入一个 scope（五个分组）
    curl -s -X PUT -H 'Content-Type: application/json' \
         -d '{"convert":{"portrait":{"format":"glb"},"landscape":{"format":"glb"}},"preview":{"portrait":{"grid":true,"speed":1}}}' \
         http://127.0.0.1:3000/api/settings/fbx2glb               # FBX→GLB 子应用（两组；值没有方向语义所以两个方向都写）
    curl -s http://127.0.0.1:3000/api/settings/shooter              # 读回
    cat data/settings.json                                          # 落盘内容
    curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/data/settings.json   # 必须是 404

    持久化证明：写入后 `touch apps/shooter/src/camera.ts` 让 watcher 重建 + 重启服务器，再读一次仍然在。

---

## 12. 如何扩展

- **加子应用**：在 `apps/<id>` 下放 manifest/index.html/styles.css/main.ts，`npm run build`。详见第 8 节。
- **改门户外观**：编辑 `shell/styles.css`（CSS 变量集中定义在 `:root`）；改主页结构在 `shell/main.ts` 的 `renderHome()`。
- **加后端 API**：在 `server/src/index.ts` 的 `http.createServer` 回调里，按第 4 节的路由顺序加匹配分支。
- **给子应用加设置项**：
  1. 服务端不用动 —— 设置存储是通用的 `GET/PUT /api/settings/:scope`（scope 用应用 id）。
  2. 在 `apps/<id>/src/settings.ts` 里定义**分组**（`shooter` 现在是 `stick`/`camera`/`vision`/`light`/`fog`/`look` 六组，形状 `scope.<组>.<方向>.<键>`）、键名、`LIMITS`（范围/步长）、`defaultsFor(...)`（**默认值必须与改动前的硬编码表现一致**）、`effectiveFor(...)`（默认值 ⊕ 稀疏覆盖 → 钳制）。保持**无 DOM、无 fetch**（只允许 import 像 `camera.ts` 那样的纯叶子模块），这样能进 `scripts/verify-stick.mjs` 这类 node 脚本。
  3. 客户端用 `shared/src/settings.ts` 的 `loadSettings/saveSettings`，**只存用户改过的键**，保存时提交内存里的完整 scope 对象并保留未知键（见 AGENTS.md「设置与用户数据」）。
  4. 改完在 `apps/<id>/README.md` 记录键名/范围/默认值/生效时机/失败降级，并用 `curl` 验证「刷新 + 重启 + 重建后仍在」。
  5. 可复制的样板：`apps/shooter/src/settings.ts`（纯 schema，六组）+ `settingsPanel.ts`（**满屏分页面板**：固定头 + 固定页签 + 唯一滚动体，一页一组，滑块/回调/防抖保存）。**非 CSS 的设置**（如摄像机高度/水平角度）不要直接 import 渲染模块：用 `opts.onXxxChange` 回调，由 `main.ts` 转给 renderer（同一个值有两个消费者时——偏航同时给 renderer 与 input——也让 `main.ts` 去分发，面板不知道它们存在）。
- **满屏弹层要「固定头 + 唯一滚动体 + 分页」，而且这三条要用源码级断言钉住**（射击子应用的设置面板重构）：把面板做成 `position:absolute;inset:0;display:flex;flex-direction:column`、头部与页签 `flex:none`、正文 `flex:1;min-height:0;overflow-y:auto`，那么「关闭按钮锚定在左上角不滚动」就不是定位技巧而是**结构**（✕ 是头部的第一个子节点）；一页一组只切换 `hidden`，每个页面都不需要滚动。两条只有做过才知道的细节：① **`[hidden]` 必须自己写规则**——UA 样式的 `[hidden]{display:none}` 输给任何作者 `display`，而面板/页面都设了 `display:flex`，所以 `.panel[hidden]`、`.page[hidden]` 各要一条显式 `display:none`（否则「隐藏」的面板照样铺满屏幕）；② **横屏媒体查询要整段删掉、不能只删一半**——原来为了把 ~56vh 的面板塞进矮视口，横屏里有一整套字号/盒子覆盖；满屏之后它们只会造成「横竖屏字号不一样」（用户真实反馈），而这类覆盖**没有运行时症状**，所以 `verify-panel.mjs` 直接读 `styles.css` 断言「横屏块里不再出现任何 `.settings-panel`/`.set-*`」。**同理断言 `inset:0`、唯一滚动体的 `overflow-y:auto`、两列 grid 的模板**：CSS 结构约定必须被源码级断言钉住，否则后来者加一条 `max-height` 就悄悄退化了。
- **换门户名/描述**：`server/src/registry.ts` 的 `PORTAL` 常量（以及 `package.json` 的 `version`）。
- **接入 PWA/离线**：当前未做；需要可增加 `manifest.webmanifest` + service worker（注册在门户外壳即可，子应用同源同域可继承）。
- **开机自启**：可在 Termux 用 `~/.termux/boot/`（配 `termux-boot`）或 `termux-services` 拉起 `npm start`。

---

## 13. 已知限制 / 待办

- 门户目前**无 PWA（离线/添加到主屏）**能力；子应用内容仍依赖各浏览器 `localStorage`。
- **设置存储是单用户、无鉴权的**（与本机门户定位一致）：任何能访问 `:3000` 的人都能读写 `/api/settings`。**不要**往里面放密码/token 之类的机密。
- **设置无版本迁移**：`data/settings.json` 是扁平 map，没有 `version` 字段，键被重命名/语义变更时只能由应用侧兼容或手工清理文件。当前规模（摇杆布局 + 摄像机高度 + 遮挡变暗 + 环境光 + 方向光 + 高度雾）不值得引入迁移框架。**注意「默认值可以随版本变化」这条容易被忽略**：稀疏覆盖的设计意味着"用户没调过的键跟着代码默认值走"，所以把环境光出厂值一路调到 **0**（1.05 → 0.42 → 0.14 → 0）时，**没拖过滑杆的用户**文件里根本没有 `light` 键，升级后**立刻**就是新观感——这是有意的（用户要的正是这个变化），但下次想「升级后观感不变」时，必须像相机那次一样让新默认等于旧硬编码值，而不是指望用户文件里记着什么。反过来，**已经用滑杆存过倍率的用户不会被新默认值影响**：那个倍率原样乘到新基强度上（相对语义不变、绝对值跟着变）。存「倍率」而不是存「绝对强度」就是为此选的——历次下调自动作用到已保存的设置上。**但这条有个真实的副作用，本项目已经踩到**：用户要求「把环境光改成 0」时，真机上那个方向因为存着 `light.portrait.ambient = 1.95`，实际强度是 `0.273` 而不是 0（另一个方向没有覆盖，才是 0）——**"把某个默认值改成 X"和"让用户看到 X"是两件事**，凡是"改成 0/关掉"这类需求，都要先 `GET /api/settings/<scope>` 看一眼有没有覆盖，并在回复里说清怎么清掉它。
- **GLSL 在本环境无法编译验证**：射击子应用的高度雾走 `onBeforeCompile` 注入（`apps/shooter/src/fog.ts` + `toon.ts`）。`scripts/verify-fog.mjs` 能证明锚点存在且唯一、世界观感的注入点落在 `colorspace_fragment` 左边且夹在编码/解码之间、手写的 sRGB EOTF 与 three 的 `sRGBTransferOETF` 往返误差 < 1/255、世界坐标公式与引擎的 `worldpos_vertex` 等价、缺锚点时整体不补、以及 JS 侧公式正确，但**「GPU 收不收这段 GLSL」只能靠真机**。异常时的逃生开关是把「雾」拖到 0（混合变成空操作，不需要重编译），见 `apps/shooter/README.md`。
- **设置无并发冲突解决**：两个浏览器窗口同时改同一 scope 时是「后写覆盖」（整 scope 替换）。本机单用户场景可接受。
- **`data/settings.json` 无备份**：文件损坏会被当成 `{}`（不崩），但内容也就没了。
- **无用户自建在线"添加子应用"界面**（只能靠加目录 + 重建）。
- **iframe 内无法自动跟随系统主题**；门户与子应用各自管理主题。
- `server/src/index.ts` 的 `SHELL_INDEX` 未用（见第 10 节）。
- 门户主页是**静态渲染**（拉一次 manifest），不做任何服务端模板注入；如需 SEO/SSR 应另走方案。
- **横屏锁定只在部分浏览器可用**：Chrome/Edge（Android）可以；**iOS Safari 与 Firefox 没有实现 `screen.orientation.lock()`**，外壳的「横屏」按钮会渲染为 disabled。桌面浏览器大多也不支持。另外从门户「新标签 ↗」直接打开子应用时，子应用本身没有这个按钮（它虽然成了顶层文档，但没接这套逻辑）——想要就在子应用里自己调。
- **整个门户都没有页面缩放了**（根因与取舍见第 7 节「页面缩放锁」）：外壳的 viewport 锁是**全局**的，所以笔记这类文本应用也失去了双指放大。要按需恢复，得把静态 meta 改成「按路由动态改写 `viewport`」。另外 **Android Chrome 的无障碍开关「强制允许缩放」会覆盖 `user-scalable=no`**：那种情况下只剩 `touch-action` 那两层兜底（`touch-action` 不受该开关影响，双击放大仍会被挡），但双指缩放是用户可以强行打开的显式行为，属于预期。**真机待确认**：双击不再放大、双摇杆两指按法不会触发缩放/平移 —— 本环境没有浏览器，`scripts/verify-zoom-lock.mjs` 只能断言这几层规则还在（17 项）。

---

## 14. 逐文件快速定位表

| 想改什么 | 去哪个文件 |
|---|---|
| 服务器路由 / MIME / 端口 / 请求体读取 | `server/src/index.ts` |
| 设置存储（原子写、校验、串行队列） | `server/src/settings.ts` |
| 设置 API 的浏览器侧封装 | `shared/src/settings.ts` |
| 设置文件（运行时生成） | `data/settings.json`（gitignore，勿放 `dist/`） |
| 门户元信息 / 发现逻辑 / ROOT 常量 | `server/src/registry.ts` |
| 前后端共享类型 | `shared/src/types.ts` |
| 门户主页结构 / 路由 / iframe | `shell/main.ts` |
| 门户样式 | `shell/styles.css` |
| 构建管线 | `scripts/build.mjs` |
| dev 监督者（`npm run dev`） | `scripts/dev-serve.mjs` |
| 摇杆/相机/设置验证脚本 | `scripts/verify-stick.mjs` |
| 设置面板 + 离散动作按钮 DOM 接线验证（DOM shim） | `scripts/verify-panel.mjs` |
| 背包/物品/备弹/护甲（等级阶梯、堆叠、槽位规则、敌人配甲、投掷治疗、HUD 读数、背包面板拖放） | `scripts/verify-inventory.mjs` |
| 射击子应用的燃烧 DoT + 粒子特效（跳点/叠层/火焰/六层爆炸/朝向） | `scripts/verify-burn.mjs` |
| 射击子应用的弹夹/换弹 + 冲锋枪（时序/帧率无关/散布） | `scripts/verify-ammo.mjs` |
| 射击子应用的近战 180° 锥 + 挥砍新月（速度曲线/跟随角色/扫掠/软边/几何/朝向） | `scripts/verify-melee.mjs` |
| 掩体的布局不变量 / 碰撞解算 / 视线判定（改掩体或改地图尺寸看这里） | `apps/shooter/src/level.ts` |
| 掩体挡子弹/刀/火箭溅射的验证 | `scripts/verify-cover.mjs` |
| 视野遮挡（可见多边形 / 变暗几何 / 门控策略 / 近身揭示半径 / 软边） | `apps/shooter/src/vision.ts` |
| 视野的验证（网格交叉验证 / 公平性不变量 / 叠加面光栅化） | `scripts/verify-vision.mjs` |
| 光照（环境光与方向光的基色/基强度 + 两个倍率的范围/默认/钳制/读数；toon 下为什么只有半球光是"环境项"、又为什么两盏方向光共用一把旋钮） | `apps/shooter/src/lighting.ts`（渲染侧接入：`render.ts::addLights/setAmbientScale/setDirectionalScale`；验证：`scripts/verify-stick.mjs` + `scripts/verify-panel.mjs`） |
| 高度雾（浓度/高度衰减/可见度上限 + 注入用的 GLSL 文本 + JS 版雾公式） | `apps/shooter/src/fog.ts`（渲染侧接入：`toon.ts::registerWorldLook/setHeightFogDensity` + `createToonMaterial`；验证：`scripts/verify-fog.mjs` + `scripts/verify-stick.mjs` + `scripts/verify-panel.mjs`） |
| 世界观感的注入点与色彩空间（雾 + 调性共用的显示空间包裹：`LinearTosRGB → 雾 → 调性 → 手写 sRGB EOTF`，锚点 = `colorspace_fragment`） | `apps/shooter/src/worldlook.ts`（验证：`scripts/verify-fog.mjs` + `scripts/verify-tone.mjs`） |
| 画面调性（冷暗部/暖亮部的 split-tone + 对比 + 饱和 + **显示空间定义域钳制**；暗角卡片几何） | `apps/shooter/src/grade.ts` + `apps/shooter/src/vignette.ts`（渲染侧接入：`toon.ts` 的同一处注入、`render.ts::setGradeStrength/setVignetteStrength/initVignette`；验证：`scripts/verify-tone.mjs`） |
| 调性度量（光照→toon→雾→调色→sRGB 的纯 JS 模型 + CIE Lab/ΔE + 调色板清单）与报告脚本 | `apps/shooter/src/tone.ts` + `scripts/analyze-tone.mjs` |
| 像素化后处理（块/target 尺寸、全屏 quad 的 GLSL、**相机对齐到块网格的稳定性数学**、**离屏 target 为 display-referred（全局输出 chunk 覆盖 + 纯拷贝 blit + 显示字节背景）**） | `apps/shooter/src/postfx.ts`（渲染侧接入：`render.ts::initPixelPass/resizePixelTarget/render/snapCameraToPixelGrid`；验证：`scripts/verify-postfx.mjs`） |
| 正交投影的取景（焦平面对齐的高度推导 + camZoom 进 frustum）+ **相机姿态的单一真相源（`cameraOffset`/`cameraEye`/`cameraBasis`/`screenToWorld`：高度与水平角度）+ 视角输入映射（`clampYawScale`/`wrapYawDeg`/`stickYawTarget`/`lookYawFromPixels`）** | `apps/shooter/src/camera.ts`（消费者：`render.ts` 的每帧位姿、`shadow.ts::visibleGroundSpans` 的可见地面拟合、`input.ts::sample` 的屏幕→世界映射与视角区；视角区尺寸：`settings.ts::lookPadSize`；验证：`scripts/verify-stick.mjs` + `verify-shadow.mjs` + `verify-postfx.mjs`） |
| 场景美术（道具目录 / 掩体填充 / 点缀散布 / 主题常量） | `apps/shooter/src/props.ts`（素材在 `apps/shooter/assets/props/`） |
| 场景美术的验证（尺寸 vs 文件 / 不越出碰撞脚印 / 房间无缝 / 确定性） | `scripts/verify-props.mjs` |
| 枪手 AI（走位三档 / 视线门控 / 开火节奏 = 预警→连发一梭子→换弹 / 生成环） | `apps/shooter/src/game.ts`（`updateGunner` / `startEnemyReload` / `spawnEnemyRound` / `resolveEnemyWeapon` / `spawnPos`） |
| 枪手 AI 的验证 | `scripts/verify-gunner.mjs` |
| 门户外壳的页面缩放锁（viewport meta / touch-action / iOS 兜底） | `shell/index.html` + `shell/styles.css` + `shell/main.ts`（验证：`scripts/verify-zoom-lock.mjs`） |
| 射击子应用的新月扫掠数学（力量曲线）+ 新月顶点数据（无 three） | `apps/shooter/src/slash.ts` |
| 射击子应用的 HUD 读数规则（余弹/备弹文本、进度条比例、护甲读数、动作按钮可见性）+ **世界空间 bar 的几何与槽位分配器** | `apps/shooter/src/hud.ts` |
| 射击子应用的护甲/穿透规则（默认公式 + **每弹药·每护甲等级覆写表**）+ 1–6 等级配色表 | `apps/shooter/src/armor.ts` |
| 射击子应用的物品目录（弹药/护甲/投掷物/治疗物 + 堆叠上限） | `apps/shooter/src/items.ts` |
| 射击子应用的背包模型（20 格 + 5 槽位 + 类型规则 + 备弹 + 默认配装） | `apps/shooter/src/inventory.ts` |
| 射击子应用的背包面板（🎒 按钮/槽位/格子/pointer 拖放） | `apps/shooter/src/inventoryPanel.ts` |
| 射击子应用的武器数据（弹夹/换弹/弹药类型 `ammoId`） | `apps/shooter/src/weapons.ts` |
| 射击子应用的粒子朝向数学（+Z 对齐三维速度） | `apps/shooter/src/streak.ts` |
| 射击子应用的枪口特效配方（三把远程武器的层列表 + 6 个物理预设 + 光源衰减曲线） | `apps/shooter/src/muzzle.ts`（挂载：`weapons.ts::RangedWeaponDef.muzzle`；生成：`game.ts::spawnMuzzleFlash`；渲染：`render.ts::sync` 的点光池；验证：`scripts/verify-muzzle.mjs`） |
| 射击子应用的瞬时光源系统（枪口闪光 + 爆炸火光共用的列表、上限、构造器闸门、衰减曲线） | `apps/shooter/src/fxlight.ts`（产出：`game.ts::spawnMuzzleFlash` 与 `game.ts::spawnExplosion`；验证：`scripts/verify-muzzle.mjs` + `scripts/verify-burn.mjs`） |
| 射击子应用的动态点光源池（子弹光 + 全部瞬时光源共用的 8 盏，从新到旧取用） | `apps/shooter/src/render.ts`（`BULLET_LIGHTS` / `lightPool` / `sync()` 的分配循环；验证：`scripts/verify-muzzle.mjs` 的源码级断言） |
| 射击子应用的相机取景几何（`CAM_H`/`CAM_BACK` + 高度倍数） | `apps/shooter/src/camera.ts` |
| 全量编译配置 | `tsconfig.json` |
| npm 脚本 | `package.json` |
