# 第三方资源：vendored three.js addons

这个目录是**原样拷进来的 three.js r160 官方模块**，没有任何修改。和 `apps/shooter/vendor/` 是同一份
`three.module.min.js`（md5 `4d8e72afd9639e074547992bce6a3de3`，已核对逐字节相同），刻意各自持有一份
—— 子应用之间不互相依赖，删掉射击子应用不会带走转换器（见 `../README.md` 的「关键技术决策」）。

| 文件 | 来源 | 用途 |
| --- | --- | --- |
| `three.module.min.js` | `three@0.160.0/build/three.module.min.js` | 运行时本体 |
| `addons/loaders/FBXLoader.js` | `three@0.160.0/examples/jsm/loaders/FBXLoader.js` | 读 FBX（ASCII + 二进制，含蒙皮/动画） |
| `addons/loaders/GLTFLoader.js` | `three@0.160.0/examples/jsm/loaders/GLTFLoader.js` | **自检**：把刚导出的 GLB 再读一遍 |
| `addons/exporters/GLTFExporter.js` | `three@0.160.0/examples/jsm/exporters/GLTFExporter.js` | 写 .glb / .gltf |
| `addons/controls/OrbitControls.js` | `three@0.160.0/examples/jsm/controls/OrbitControls.js` | 预览视角 |
| `addons/utils/BufferGeometryUtils.js` | `three@0.160.0/examples/jsm/utils/BufferGeometryUtils.js` | GLTFLoader 的静态依赖 |
| `addons/utils/SkeletonUtils.js` | `three@0.160.0/examples/jsm/utils/SkeletonUtils.js` | 减面时克隆蒙皮场景（`clone()` 会重建骨骼层级，动画仍按名字绑定） |
| `addons/utils/TextureUtils.js` | `three@0.160.0/examples/jsm/utils/TextureUtils.js` | GLTFExporter 的静态依赖 |
| `addons/curves/NURBSCurve.js` + `NURBSUtils.js` | `three@0.160.0/examples/jsm/curves/…` | FBXLoader 的静态依赖 |
| `addons/libs/fflate.module.js` | `three@0.160.0/examples/jsm/libs/fflate.module.js` | 二进制 FBX 解压 |

**另外一份不是 three addon 的依赖**（自动减面用）：

| 文件 | 来源 | 用途 |
| --- | --- | --- |
| `meshopt/meshopt_simplifier.js` | `meshoptimizer@1.2.0/meshopt_simplifier.js` | 自动减面的边折叠 simplifier |
| `meshopt/LICENSE.md` | 同上 | MIT 许可证原文 |

**为什么不用 three 自带的 `SimplifyModifier`**（实测结论，不是偏好）：它开头的
`for (const name in attributes) if (name !== 'position' && name !== 'uv' && name !== 'normal' …) geometry.deleteAttribute(name)`
会把 **`skinIndex` / `skinWeight` 直接删掉**——蒙皮角色一减面就变成不会动的静态网格；它也不认 UV 缝合线，
并丢掉多材质分组。meshoptimizer 的 simplifier **只重写索引缓冲**，顶点/蒙皮/UV 原样保留，还能把 uv 与
蒙皮权重当"属性"参与代价计算（gltfpack 走的就是这条路）。

**这个文件是自包含的**：wasm 以压缩字符串内嵌在同一个 `.js` 里（文件里的 `// embed! wasm`），
所以**不发任何网络请求**、也不需要在 `dist/` 里配 `.wasm` 的 MIME；Node 里同样能跑（验证脚本正是这么用的）。
体积 55KB（vs three 的 670KB），许可证 MIT。

**许可证**：three.js 为 MIT（<https://github.com/mrdoob/three.js/blob/dev/LICENSE>），
fflate 也随 three 以 MIT 分发。拷贝时保留了文件头部的版权声明；本目录不额外改动代码。
获取方式：`npm pack three@0.160.0` 后从 tarball 里取 `build/` 与 `examples/jsm/`；
浏览器侧用 `index.html` 里的 `<script type="importmap">` 把裸标识符 `three` 指到
`./vendor/three.module.min.js`（Node 侧由 `scripts/verify-fbx2glb.mjs` 的模块解析钩子做同一件事）。

**为什么不是 `three` 的 npm 依赖**：门户刻意零运行时依赖、无打包器（见 `docs/TECHNICAL.md` 第 2 节），
子应用直接由浏览器加载 `./vendor/*.js`。升级 three 时要同时更新本表里的版本号与 md5。
