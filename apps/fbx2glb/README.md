# 🧊 FBX → GLB（`apps/fbx2glb`）

**在浏览器里把 FBX 转成 glTF / GLB，并把多个 Mixamo 动作文件合并成一个自带全部动作的角色文件。**
解析、合并、导出、自检全部发生在本机页面里——**模型文件一个字节都不上传**。

它存在的理由很具体：Mixamo 每个动作只能单独下载一个 FBX（而且每个文件的 take 都叫 `mixamo.com`），
而消费方（比如 [射击子应用](../shooter/README.md) 的 `characters.ts`）需要的是**一个**自包含、
带全套 clip 的 `.glb`。以前这中间必须过一遍 Blender；这个子应用就是那一步。

---

## 1. 怎么用

打开门户里的 🧊 卡片（或直接访问 `/apps/fbx2glb/`）：

1. **选文件**：点「选择 .fbx 文件」（可多选），或把文件拖进虚线框；没有文件时点「载入样例」——
   会从 `./assets/sample.fbx` 载入内置的 2 骨骼蒙皮样例，用来验证整条链路。
2. **看报告**：每个文件立刻解析并列出「网格 / 骨骼 / 动作 / 包围盒高度」，解析失败的文件会标红并说明原因。
3. **选选项**（默认值就是 Mixamo 工作流，一般不用改）：GLB · 合并 · 导出动画 · 自动缩放 · 按文件名命名。
4. **点「转换为 GLB」**：产物行显示动作名、缩放、以及**自检结果**（把写出的文件用 three 的 `GLTFLoader`
   重新读一遍，报出它实际看到的网格/骨骼/动作/高度）。
5. **下载**：每个产物一个下载按钮（Blob URL，本地生成）。

### 推荐的 Mixamo 工作流

| 步骤 | 在 Mixamo 上 | 说明 |
| --- | --- | --- |
| 1 | 选角色 → 选动作 → 下载 **FBX Binary (.fbx)**, **Skin: With Skin**, **In Place 勾上** | `In Place` 很关键：不勾的话每一帧都带根位移，本应用**不做** in-place 修正 |
| 2 | 每个动作单独下载一次 | 一个动作一个文件是 Mixamo 的输出方式 |
| 3 | 把文件改名成消费方要的动作名（`idle.fbx`、`run.fbx`、`shoot.fbx`…） | 「按文件名命名」会把它变成 clip 名 |
| 4 | 一次多选全部文件 → 「合并并转换」 | 产物是一个角色 + 全套 clip |
| 5 | 看产物的「动作：idle、run、shoot…」这一行 | 名字不对就改文件名再来一次 |

> 角色本体是**自动挑的**：带蒙皮网格、骨骼最多的那个文件。所以「角色.fbx（含 skin）+ 动作.fbx × N」里
> 谁是本体不用你指定；如果本体不是列表里的第一个，日志会提示一句。

---

## 2. 架构与模块职责

```
apps/fbx2glb/
├─ manifest.json         # 门户注册（id = 目录名，order 6，icon 🧊）
├─ index.html            # 入口页：importmap { "three": "./vendor/three.module.min.js" } + 全部 DOM 契约
├─ styles.css            # 移动优先深色样式（卡片 / 选项行 / 列表 / 日志 / 预览框）
├─ main.ts               # 组装层：文件列表状态、DOM 渲染、日志、预览接线、流程编排
├─ src/
│  ├─ names.ts           # ★纯：文件名/动作名规则（占位名、去重、净化、CJK、下载名、字节格式）
│  ├─ units.ts           # ★纯：单位缩放判定（auto / keep / cm）
│  ├─ rig.ts             # ★纯：骨骼名匹配（精确 → 归一化，「有歧义就拒绝猜」）与轨道名重写
│  ├─ settings.ts        # ★纯：设置 schema（两组、默认值、稀疏覆盖、脏数据、钳制）
│  ├─ merge.ts           # 合并规则：挑本体、覆盖率门、重定向轨道、改名（用 three 的 AnimationClip）
│  ├─ analyze.ts         # 场景报告：计数/尺寸/骨骼名/每个 clip 的未绑定轨道（three，无 DOM）
│  ├─ convert.ts         # FBXLoader / GLTFExporter / GLTFLoader 封装 + GLB 容器数学（缩放）
│  ├─ preview.ts         # ★唯一需要 WebGL 的模块：渲染 + OrbitControls + AnimationMixer
│  └─ panel.ts           # 选项 DOM + 服务器持久化（防抖、恢复默认、失败降级）
└─ assets/sample.fbx     # 手写的 ASCII FBX 样例（也是验证脚本的输入；见第 5 节）
```

（★ = 无 DOM，可被 `scripts/verify-fbx2glb.mjs` 在 Node 里直接跑。）

**数据流（一条直线，没有隐藏状态）**：

```
File ──arrayBuffer──▶ FBXLoader.parse ──▶ { root, clips }
                                          │
                          describeScene ───┤（报告 + 高度）
                                          ▼
   mergeScenes（挑本体 / 覆盖率门 / 重定向 / 改名）──▶ { root, clips }
                                          │
                       resolveScale(units.ts) ──▶ ×1 或 ×0.01
                                          ▼
                     GLTFExporter.parse ──▶ GLB ──▶ scaleGlb（JSON 层加缩放节点）
                                          │
                              GLTFLoader.parse ──▶ 自检报告
                                          ▼
                              Blob URL ──▶ 下载（不回服务器）
```

---

## 3. 关键技术决策（含被否决的方案）

### 3.1 为什么是「浏览器里的子应用」而不是 CLI / 上传服务 / 在线转换网站

| 方案 | 否决理由 |
| --- | --- |
| Node CLI 脚本（`scripts/fbx2glb.mjs`） | 这条路本环境**跑不动贴图**：`FBXLoader` 解析内嵌贴图要 `window.URL.createObjectURL` + `Blob`，`GLTFExporter` 的二进制路径要 `FileReader`、图像还要 `document.createElement('canvas')`。都要垫 shim，垫出来的东西和真机行为不一致；而门户本来就是一个跑在手机上的网站，「选文件 → 下载」是原生能力 |
| 上传到服务器转换 | 门户后端刻意**零运行时依赖**（见 [TECHNICAL](../../docs/TECHNICAL.md) 第 2 节），加一个 FBX 解析器（或外部进程 Blender）会打破这条不变量；而且用户还得把模型传出去 |
| 在线转换网站 | 要么丢掉骨骼/动画（多数只处理静态网格），要么把 Mixamo 资产传给第三方——Mixamo 的条款本来就禁止把它的资产当作独立资产再分发 |
| **浏览器内转换**（选中） | 文件不出设备；用的是 three 官方 `FBXLoader`/`GLTFExporter`（和 app 里 vendor 的同一份）；手机上就能跑；渲染预览白送 |

### 3.2 vendor 一份自己的 three（而不是共用）

`vendor/` 里是 three r160 的原样拷贝（`three.module.min.js` 与 `apps/shooter/vendor/` **逐字节相同**，
md5 `4d8e72afd9639e074547992bce6a3de3`，验证脚本会断言这一点）。**刻意重复这 670KB**：
子应用之间不互相依赖，删掉射击子应用不会带走转换器，转换器也不需要知道射击子应用存在。
被否决的是「把 three 提到根目录共享」——那要改 `scripts/build.mjs`（平台层），为一个 670KB 的拷贝
换一次全局重建 + 全套回归，不划算。清单与许可证见 [`vendor/README.md`](vendor/README.md)。

### 3.3 合并语义：只搬动画，不搬场景

`mergeScenes()` 的行为被刻意收窄：

1. **挑本体**：`(有蒙皮网格 ? 1e6 : 0) + 骨骼数` 最大者（并列取靠前的）。只有它能当角色；
2. **覆盖率门**：其它文件与本体做骨架匹配，覆盖率 < **50%** 就**跳过**并在日志里写清
   （`M/N 根骨骼能在角色上找到`）。被否决的是「照单全收」——那样会产出一个文件里躺着永远播不动的
   clip，而 three 对找不到节点的轨道**完全静默**；
3. **重定向**：能匹配上的文件，把它的轨道名改成角色骨架的名字（见 3.4），再挂上 clip；
4. **改名**：所有接受的 clip 一起命名（见 3.5）。

### 3.4 骨骼名匹配：精确优先，归一化次之，有歧义就拒绝

同一个 Mixamo 角色，不同导出批次的名字会漂移：Blender 二次导出会加 `.001`（three 净化后是 `Hips001`），
第二套 Mixamo 绑定叫 `mixamorig5Hips`，Maya 会给 `Hips_1`。`rig.ts::deriveBoneMap()` 因此分两步：

1. **名字完全相同** → 恒等映射（最大的一类，不猜）；
2. 剩下的按「核心名」匹配（小写、去掉非字母数字、去掉数字）：`mixamorig5Hips → mixamorighips`、`Hips001 → hips`。
   **只在一根核心名对应唯一一根未使用骨骼时才采用**；`Spine1`/`Spine2` 这种会两边都出现歧义，
   于是**拒绝映射并把歧义报出来**——猜错会静默地把动画绑到错误的骨头上，比不绑更糟。

### 3.5 动作命名：占位名检测 + 去重（这是本应用最容易被忽略的部分）

Mixamo 每一次下载的 take 名都是 **`mixamo.com`**。直接合并不做处理，产物里就会出现 6 个同名 clip，
而按名字取动画的消费方只会拿到第一个。规则（`names.ts`，全部有断言）：

- **按文件名命名（默认）**：clip 名 = FBX 文件名（去掉扩展名、净化非法字符、保留中文）。于是
  「把文件命名成 `idle.fbx`」就等价于「把动作命名成 `idle`」——不需要再做一个重命名 UI。
- **按文件里的动作名**：用 clip 自己的名字，但命中占位名表（`mixamo.com` / `mixamo.com.001` /
  `Take 001` / `Animation` / `Anim 1`…）时**退回文件名**。名字不是自己选的，不如用一个自己能选的。
- **去重**：候选名字重复时追加 `-2`、`-3`…（`idle`、`idle-2`）；结果会再查一遍表，
  所以真有文件叫 `idle-2.fbx` 也不会撞车。

### 3.6 单位缩放：只做「厘米 → 米」这一件事，而且是量出来的

Mixamo 的角色是 **100 单位高**（FBX 的厘米口径），glTF/three 里 1 单位 = 1 米，直接转就是
180 米高的巨人。`units.ts::resolveScale()`：

- `auto`（默认）：**量**包围盒高度，`> 20` 单位就判为厘米、乘 `0.01`；
- `keep`：原样 ×1（模型本来就是米制，或者消费方想自己归一化）；
- `cm`：无条件 ×0.01。

被否决的是「按期望身高归一化」（把高度缩放到目标值）：那会把一个故意做小的道具（0.2 单位的茶杯）
放大成 1.8 单位的怪物。阈值 20 是很宽的带（人形米制 1.5–2.0、厘米制 150–200），两侧都有断言。

**预览里显示的是原始尺寸，缩放只在导出时应用**——日志会写「测得高度 160.00 个单位 → 判定为厘米，
导出时 ×0.01」，这样"我是不是选错了缩放"当场就能看出来。

### 3.7 ⚠️ 导出缩放必须加在**成品 glTF 的 JSON 节点**上，不能包一个 three `Group`

这是本项目最值得记的一个坑，两个方向都被真实验证脚本抓到过：

1. **包 `Group` 会缩放两次**（`1.6 → 0.00016` 而不是 `0.016`）。原因：`GLTFExporter` 写出的
   inverse bind matrices 来自 `boneInverses[i] × bindMatrix`，而顶点数据与骨骼层级保持原数值；
   于是「父节点缩放」同时进了蒙皮数学（骨头世界矩阵被缩放）与节点变换两处。
2. **`new Box3().setFromObject(root)` 对 SkinnedMesh 会把世界空间二次乘**：three r160 的
   `SkinnedMesh.computeBoundingBox()` 是通过 `getVertexPosition()`（= `bone.matrixWorld`）算的，
   结果**已经是世界空间**，而 `Box3.expandByObject()` 之后又乘了一次 `object.matrixWorld`。
   在无缩放的层级上完全看不出来（单位阵），一旦有缩放就把尺寸量成 `scale²` 级别——
   正好毁掉「单位对不对」这个问题本身。

因此：`convert.ts::wrapSceneRoot()` 在**导出完成后**给 `json.scenes[0].nodes` 加一个
`{ scale: [s,s,s], children: [...原根] }` 的包裹节点（二进制路径就是 `readGlb` → 改 JSON → `writeGlb`，
BIN chunk 一个字节不动）；`analyze.ts::measureSize()` 则是手写的
「`geometry.boundingBox` × `object.matrixWorld`」遍历。两条都有断言：
「×0.01 后高度正好是 1.6 厘米」「缩放前后高度正好差 100 倍」「缩放没有改动 BIN 一个字节」。

### 3.8 自检：导出后必须重新读回来

产物是二进制，唯一诚实的说法是「一个全新的加载器把它读回来了，看到这些 clip / 这些骨骼 / 这个高度」。
`convert.ts::selfCheck()` 就是这件事（用 vendored `GLTFLoader`）；结果直接印在产物行上，
读不回来就明确写「自检失败：…」。它也是「合并后轨道是否真的能绑定」的兜底观察点。

### 3.9 设置存储：沿用 `scope.<组>.<方向>.<键>`，但**两个方向同时写**

AGENTS.md 规定的路径形状是 `scope.<组>.<方向>.<键>`（射击子应用的布局值确实随横竖屏不同）。
本应用**没有任何随方向变化的选项**：导出格式或单位缩放如果跟着转屏变，那就是 bug。取舍：

- 保留那层 `<方向>`（存储形状统一、面板的合并路径不需要特例），
- 但**每次写入都同时写两个方向**（`writeConvertOverride` / `writePreviewOverride`），
  于是界面上永远不可能出现「转屏后格式变了」；
- 手工编辑的文件若只写了一个方向，读取时以当前方向为准、另一个回落默认值（有断言钉住这条语义）。

被否决的是「省掉方向层」——那会让本应用成为唯一一个存储形状不同的子应用。

### 3.10 其他被否决的做法

- **合并时把多个 FBX 的网格也拼进一个场景**：没有必要（角色只需要一套网格），而且会把多份骨架、
  多份材质、多份贴图都塞进产物。
- **在做合并时顺便居中 / 修朝向 / 剥手持物**：射击子应用是在**加载时**做归一化和剥离的
  （`normalizeModel` / `strip`），转换器再做一次会让同一件事有两处真相。
- **加一个「编辑 clip 名」的 UI**：文件名就是命名接口（3.5），多一个 UI 就多一份需要持久化的状态。
- **把 FBX 转换放到后端做**：见 3.1。
- **「恢复默认」只清内存、不落盘**（是这一轮真被 DOM shim 测试抓到的 bug）：面板的 `flush()` 在「没有待写改动」时
  会直接返回，而「恢复默认」只改了内存里的对象、没有把 `dirty` 置起来，于是用户点完恢复默认、刷新页面，
  旧值又回来了——**看起来生效、实际没保存**。修法是 `panel.ts::resetGroup()` 里显式 `dirty = true` 再 `flush()`，
  并且让测试断言「恢复默认之后确实又多了一次 PUT」。**通用教训**：「改了内存里的设置对象」和「安排一次保存」
  是两件事，前者不会自动触发后者。

---

## 4. 设置（scope `fbx2glb`）

持久化走 `GET/PUT /api/settings/fbx2glb` → `data/settings.json`（**永不写 localStorage**，
验证脚本有源码级断言）。稀疏覆盖：只存改过的键；保存时提交内存里的完整 scope 对象并原样保留
未知键。两组各有自己的「恢复默认」，只清自己那组。

| 组 | 键 | 取值 | 默认 | 生效时机 |
| --- | --- | --- | --- | --- |
| `convert` 转换选项 | `format` | `glb` \| `gltf` | `glb` | 下一次转换 |
| | `merge` | 布尔 | `true` | 下一次转换（并影响按钮文案） |
| | `animations` | 布尔 | `true` | 下一次转换 |
| | `scaleMode` | `auto` \| `keep` \| `cm` | `auto` | 下一次转换 |
| | `clipNaming` | `file` \| `clip` | `file` | 下一次转换 |
| `preview` 预览 | `grid` | 布尔 | `true` | 立即 |
| | `bones` | 布尔 | `false` | 立即 |
| | `speed` | 0.1–2，步长 0.1（越界钳制、NaN→1） | `1` | 立即（拖动实时预览，松手才落盘） |

**失败降级**：读不到服务器 → 用代码里的默认值，状态行显示「未连接服务器，设置无法保存：…」；
保存失败 → 内存里的值照常生效并显示「保存失败（仅本地生效）：…」，下一次改动会重试。
脏数据（枚举不认识、类型不对）**丢弃而不是抛错**；`speed` 越界钳制、按步长吸附。

> 与射击子应用一样：`<方向>` 层存在但没有语义（见 3.9）。

---

## 5. 外部资源与许可证

| 资源 | 位置 | 许可证 | 说明 |
| --- | --- | --- | --- |
| [Three.js](https://threejs.org) r160（`three.module.min.js` + `FBXLoader` / `GLTFExporter` / `GLTFLoader` / `OrbitControls` / `BufferGeometryUtils` / `TextureUtils` / `NURBSCurve` / `fflate`） | `apps/fbx2glb/vendor/`（1.2MB） | MIT | 原样拷贝，无 CDN 依赖；清单/版本/获取方式/md5 见 [`vendor/README.md`](vendor/README.md) |
| `assets/sample.fbx` | `apps/fbx2glb/assets/` | 本仓库自有（无第三方素材） | **手写**的 ASCII FBX 7.4：2 骨骼蒙皮盒子 + 两个 take 都叫 `mixamo.com` 的动画，9KB |

**关于 Mixamo 资产（本应用不内置任何 Mixamo 文件）**：Mixamo 的模型/动画可免费商用、无需署名，
但其条款要求「**不能作为独立资产再分发**，必须并入更大的作品」。所以：

- 本仓库**不提交**任何 Mixamo 下载物或由它转换出来的 `.glb`；
- 你用这个工具转出来的文件，要不要入库由你判断（模型作为「更大作品的一部分」通常没问题，
  但把角色本体作为素材单独放进公开仓库是有风险的）。

---

## 6. 已知限制 / 待办

- **需真机确认**（本环境没有浏览器，见 [TECHNICAL](../../docs/TECHNICAL.md) 第 5 节）：
  - 预览的 WebGL 渲染、OrbitControls 的单指旋转/双指缩放是否顺手、大模型（10MB 级 FBX）转动是否掉帧；
  - 手机文件选择器里 `accept=".fbx"` 是否真的列出 `.fbx`（Android 的 picker 有时按 MIME 过滤；
    万一不列出，用「载入样例」可以验证除选择器之外的整条链路）；
  - 一次多选 6–10 个 Mixamo 文件的解析耗时与内存（全部在 JS 堆里：File → ArrayBuffer → 场景 → GLB）。
- **外部贴图**：FBX 若把贴图作为**外部文件**引用（`body_diffuse.png` 之类），浏览器拿不到那些文件，
  产物会缺贴图；FBX 自带的材质颜色会保留。内嵌贴图正常。
- **不做的**：不居中、不修朝向、不改骨骼名、不重定向不同骨架的动画、不做 in-place 修正、
  不剥手持武器/配件、不烘焙动画、不压缩纹理。
- **不做 in-place 修正的后果**：Mixamo 下载时若不勾 `In Place`，走跑动作自带根位移，
  产物里也会有（消费方自己决定要不要保留）。
- **three 的 console 警告**：`GLTFExporter` 对 `MeshPhongMaterial`（FBXLoader 的常见产物）
  会打印「Use MeshStandardMaterial or MeshBasicMaterial for best results」；产物里仍是标准 PBR 材质。
  这些警告只进浏览器控制台，**不会**出现在页面日志里。
- **没有批量重命名 UI**：命名靠文件名（3.5）。
- **一次只有一个预览场景**：切文件会替换预览，不做多标签。
- **多次产物要逐个点下载**：浏览器不允许多个下载同时触发（每个产物一行按钮，点了才生成 Blob URL）。

---

## 7. 如何扩展

- **加一个转换选项**：`src/settings.ts`（键名/取值/默认值/校验）→ `src/panel.ts`（DOM + 写入 +
  `恢复默认`）→ `index.html`（控件 + id）→ 本 README 的设置表 → `scripts/verify-fbx2glb.mjs`
  的 schema 断言。四步缺一不可（AGENTS.md「设置与用户数据」第 4 条）。
- **加一个命名/合并规则**：改 `names.ts` / `rig.ts` / `merge.ts`（都是纯逻辑），
  在验证脚本对应小节补断言——那里的断言数是本应用的回归门。
- **换/加样例**：替换 `assets/sample.fbx`（保持 ASCII、保持小），并同步验证脚本第 6 节的
  实测数字（骨骼数、动作数、高度、take 名）。
- **升级 three**：整个 `vendor/` 一起换（含 addons），更新 `vendor/README.md` 的版本与 md5，
  同步 `apps/shooter/vendor/` 的版本断言，然后**跑全套**（平台层/vendor 变更 + 断言数变化）。

---

## 8. 验证

### 改了哪里 → 跑哪个脚本

| 改动 | 跑什么 |
| --- | --- |
| 本应用的任何逻辑 / DOM / 设置 / 样例 | `node scripts/verify-fbx2glb.mjs`（**258 项断言**，1 个脚本） |
| `shared/src/settings.ts`、`server/`、`shell/`、`scripts/`、vendor | **全套**（21 个脚本；`verify-spawn-cost.mjs` 需要 `--expose-gc`） |

另外每次都做：`curl` 具体 URL、写明真机确认项（AGENTS.md 启动与验证 第 3、5 条）。

```bash
# 构建由 npm run dev 的 watcher 负责（不要手动 npm run build，见 AGENTS.md 第 2 条）
node scripts/verify-fbx2glb.mjs

curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/apps/fbx2glb/
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/apps/fbx2glb/assets/sample.fbx
curl -s http://localhost:3000/api/manifest | grep -o '"id":"fbx2glb"[^}]*'
curl -s http://localhost:3000/api/settings/fbx2glb
```

### 这个脚本证明什么（而不是「跑过了」）

1. **真管线跑真文件**：`assets/sample.fbx` 经 vendored `FBXLoader` → `1 蒙皮网格 / 2 骨骼 / 2 动作 /
   1.6 高`，轨道名是 `mixamorigSpine.quaternion`、`mixamorigHips.position`；
2. **合并真的重定向**：把 `mixamorig5Hips/mixamorig5Spine` 的第二个文件合进角色后，
   `unboundTracks` 必须为空——这条断言的存在理由就是「轨道绑不上是**完全静默**的失败」；
   骨架完全对不上的文件必须被跳过并给出原因；
3. **产物自包含**：GLB magic/版本/长度/4 字节对齐/单一 buffer/整份 JSON 里没有 `uri`/skin 关节数/
   每条动画通道都指向关节；`.gltf` 路径的 buffer 必须是 `data:` URI；
4. **自检闭环**：用 vendored `GLTFLoader` 重新读回产物，动作名、骨骼数、高度逐项一致；
5. **缩放只发生一次**：×0.01 后高度 = 1.6 厘米，且正好是未缩放高度的 1/100；容器往返与
   「缩放不动 BIN」也有断言（第 3.7 节那两个坑的回归门）；
6. **规则就是文档里写的规则**：占位名表、去重（含 `hero`/`hero-2`…）、CJK 文件名、
   单位阈值两侧、骨架匹配的歧义拒绝、设置 schema（默认值/稀疏覆盖/脏数据/两组重置/速度钳制）；
7. **不上传**：源码级断言「没有 `localStorage`」「没有 `XMLHttpRequest`/`FormData`」
   「整个应用只有一处 `fetch`，且只取 `./assets/sample.fbx`」；`JS` 里取的每个 DOM id 都必须在
   `index.html` 里存在；引用的每个 vendor addon 都必须在 dist 里；两份 vendor three 的 md5 相同。

8. **页面真的能跑**：`scripts/verify-fbx2glb.mjs` 最后一节用 DOM shim 启动**真实的 `dist/apps/fbx2glb/main.js`**
   （元素 id 与标签直接从 `index.html` 解析，控件消失就会红），然后走一遍用户流程：载入样例 → 报告两骨骼两动作 →
   转换出一个 `sample.glb` → 点下载（断言**没有网络请求**）→ 改格式（断言 400ms 防抖后**只发一次 PUT 且两个方向都写**）
   → 再转一次（`.gltf`）→ 再加一个文件、关掉合并（两个产物各按自己的文件名命名）→ 打开合并（四个动作名齐全不重名）
   → 「恢复默认」（断言**真的再发一次 PUT**）→ 清空。没有 WebGL 时的降级路径也在这条流程里（预览 fallback 显示、画布隐藏）。

> ⚠️ **不证明**：预览好不好看、手势顺不顺手、大文件在手机上要多久——**需真机确认**（第 6 节）。
