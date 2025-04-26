# 🛀 蓝牙水控器 FOSS 的 Tauri 增强版

深圳市常工电子“蓝牙水控器”控制程序的开源实现。适用于国内各大高校宿舍热水器。

使用 `Tauri` 进行功能增强，可以自动连接指定水控器，自动重连，解决 7 分钟断一次的问题。

![waterctl](waterctl.jpg)

## 🏃 使用

- 先 fork 一份本仓库，然后找到 `src/bluetooth.ts` 中的

  ```
  // 设备常量
  const DEVICE_NAME = "Water36088";
  ```

  这部分代码中的 `Water36088` 需要改为你的蓝牙水控器的蓝牙名称，保存。

- 在 GitHub 仓库设置以下环境变量（apk编译需要）：

  ```
  ANDROID_RELEASE_KEYSTORE --> 你的 keystore 文件经过 Base64 编码后的内容
  ANDROID_RELEASE_PASSWORD --> keystore 的密码
  ANDROID_RELEASE_KEY --> 密钥名称
  ANDROID_RELEASE_KEY_PASSWORD --> 密钥的密码
  ```

- 等待 github action 的 workflow 编译并发布好 release,即可在最新的 release 界面下载你想要的包并开始使用了
- 不能用？请先看看”疑难解答“： https://github.com/celesWuff/waterctl/blob/2.x/FAQ.md

## ⚠️ 注意

- 项目是 `Tauri 2.0` 项目，可编译为安卓，iOS 的安装包，但因效果不好不建议使用
- `src/bluetooth.ts`中许多有关 `autoReconnect`的判断的代码处存在 `setTimeout`函数，其中的第二个参数，即延迟执行的时间（单位：ms），可按个人喜好修改，并未最佳延迟时间
- `src/bluetooth.ts`中 `autoReconnect` 变量的值若改为 `false` , 则退化为原版程序，不会自动重连，但仍能指定水控器

## ✨ 特性

- 🌐 真正离线使用，不依赖互联网连接（你可以在离线状态下打开本应用）
- 🖕 完全脱离“微信”，夺回对科技的控制权
- ⚛️ 使用开放的 Web 技术构建
- 💡 简洁，明确，美观的操作界面
- ⚡ 响应速度极快
- 🔥 简化的交互逻辑
- 🖥️ 支持 自动化执行 ，无需手动执行操作
- 📱 支持 Windows/Linux/macOS
- 👍 开放源代码
- 🛠 更多特性开发中

## ♿ 项目依赖

- [celesWuff/waterctl](https://github.com/celesWuff/waterctl) 蓝牙水控器 原项目
- [tauri-apps/tauri](https://github.com/tauri-apps/tauri) 提供了主体 ui 及拓展能力的支持
- [MnlPhlp/tauri-plugin-blec](https://github.com/MnlPhlp/tauri-plugin-blec) 提供了蓝牙支持

## 📜 开源许可

基于 [MIT license](https://opensource.org/licenses/MIT) 许可进行开源。
