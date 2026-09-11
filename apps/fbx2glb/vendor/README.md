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
| `addons/utils/TextureUtils.js` | `three@0.160.0/examples/jsm/utils/TextureUtils.js` | GLTFExporter 的静态依赖 |
| `addons/curves/NURBSCurve.js` + `NURBSUtils.js` | `three@0.160.0/examples/jsm/curves/…` | FBXLoader 的静态依赖 |
| `addons/libs/fflate.module.js` | `three@0.160.0/examples/jsm/libs/fflate.module.js` | 二进制 FBX 解压 |

**许可证**：three.js 为 MIT（<https://github.com/mrdoob/three.js/blob/dev/LICENSE>），
fflate 也随 three 以 MIT 分发。拷贝时保留了文件头部的版权声明；本目录不额外改动代码。
获取方式：`npm pack three@0.160.0` 后从 tarball 里取 `build/` 与 `examples/jsm/`；
浏览器侧用 `index.html` 里的 `<script type="importmap">` 把裸标识符 `three` 指到
`./vendor/three.module.min.js`（Node 侧由 `scripts/verify-fbx2glb.mjs` 的模块解析钩子做同一件事）。

**为什么不是 `three` 的 npm 依赖**：门户刻意零运行时依赖、无打包器（见 `docs/TECHNICAL.md` 第 2 节），
子应用直接由浏览器加载 `./vendor/*.js`。升级 three 时要同时更新本表里的版本号与 md5。
