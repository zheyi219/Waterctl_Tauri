import { resolveError } from "./errors";
import { clearLogs, getLogs, isLogEmpty, log } from "./logger";
import { endEpilogue, baAck, offlinebombFix, startPrologue, endPrologue } from "./payloads";
import { makeStartEpilogue, makeUnlockResponse } from "./solvers";
import { bufferToHexString } from "./utils";
import { connect, disconnect as bleDisconnect, send, subscribe, startScan, BleDevice, stopScan } from '@mnlphlp/plugin-blec';
import { startCountdown, CountdownController } from "./Countdown";

// 设备常量
const DEVICE_NAME = "Water36088";
//const DEVICE_ADDRESS = "6D:6C:00:02:73:63";
// const SERVICE_UUID = "0000f1f0-0000-1000-8000-00805f9b34fb";
const TXD_UUID = "0000f1f1-0000-1000-8000-00805f9b34fb";
const RXD_UUID = "0000f1f2-0000-1000-8000-00805f9b34fb";

let bluetoothdevice: BleDevice;

// 状态变量
let isStarted = false;
let autoReconnect = true;

let pendingStartEpilogue: number; // workaround for determining new firmware, see handleRxdNotifications
let pendingTimeoutMessage: number; // if we don't get a response in time, we should show an error message

let countdown: CountdownController; //prepare for the countdown

async function writeValue(value: Uint8Array) {
  const msg = "TXD: " + bufferToHexString(value);
  log(msg);
  await send(TXD_UUID, value);
}

// UI控制函数
function updateUi(stage: "pending" | "ok" | "standby") {
  const mainButton = document.getElementById("main-button")! as HTMLButtonElement;
  const deviceName = document.getElementById("device-name")! as HTMLSpanElement;
  const counterElement = document.getElementById("counter") as HTMLElement;

  switch (stage) {
    case "pending":
      mainButton.textContent = "请稍候";
      mainButton.disabled = true;
      deviceName.textContent = "已连接：" + bluetoothdevice.name!;
      break;
    case "ok":
      mainButton.textContent = "结束";
      mainButton.disabled = false;
      //start countdown
      countdown = startCountdown(420, counterElement, () => {
        console.log("时间到！");
      });
      break;
    case "standby":
      mainButton.textContent = "开启";
      mainButton.disabled = false;
      deviceName.textContent = "未连接";
      //countdown end
      countdown.stop();
      break;
  }
}

// 断开连接处理
async function disconnect() {
  try {
    if (bluetoothdevice.isConnected) await bleDisconnect();
  } catch (error) {
    console.error("Disconnect error:", error);
  }
  isStarted = false;
  clearLogs();
  clearTimeout(pendingStartEpilogue);
  clearTimeout(pendingTimeoutMessage);
  updateUi("standby");

  //reconnect after 400ms
  if (autoReconnect) {
    setTimeout(() => {
    start();
    }, 400);
  }

}

// 错误处理
async function handleBluetoothError(error: unknown) {
  const dialogContent = document.getElementById("dialog-content")!;
  const dialogDebugContainer = document.getElementById("dialog-debug-container")!;
  const dialogDebugContent = document.getElementById("dialog-debug-content")!;

  const { output, isFatal, showLogs } = resolveError(error);
  output(dialogContent, error);

  dialogDebugContainer.style.display = "none";
  if (!isLogEmpty() && showLogs) {
    dialogDebugContainer.style.display = "block";
    dialogDebugContent.textContent = "调试信息：\n" + getLogs().join("\n");
  }

  const dialog = document.getElementById("dialog") as HTMLDialogElement;
  dialog.showModal(); // 显示对话框

  // 3秒后关闭对话框
  if (autoReconnect) {
    setTimeout(() => {
      dialog.close(); // 关闭对话框
    }, 3000);
  }

  if (isFatal || autoReconnect) await disconnect();
}

// RXD数据处理
// 用于存储最近接收到的数据及其出现次数
const recentDataMap = new Map<string, number>();
// 最大重复次数
const MAX_DUPLICATE_COUNT = 3;

async function handleRxdData(data: Uint8Array) {
  // 将数据转换为字符串，用于作为Map的键
  const dataKey = bufferToHexString(data);
  // 获取当前数据的重复次数
  const currentCount = recentDataMap.get(dataKey) || 0;

  // 如果重复次数达到最大限制，直接返回，不处理此次数据
  if (currentCount >= MAX_DUPLICATE_COUNT - 1) {
    return;
  }

  // 更新数据的重复次数
  recentDataMap.set(dataKey, currentCount + 1);

  // 一段时间后清除记录，避免内存泄漏
  setTimeout(() => {
    recentDataMap.delete(dataKey);
  }, 5000);

  //console.log("RXD: \ntype: "+typeof(data)+" \ncontent: " + data);
  log("RXD: " + bufferToHexString(data));
  // const dType = data[3];

  try {
    let payload = new Uint8Array(data);

    // due to a bug in the firmware, it may send an AT command "AT+STAS?" via RXD; it doesn't start with FDFD09
    if (payload[0] === 0x41 && payload[1] === 0x54 && payload[2] === 0x2b) {
      return;
    }

    if (payload[0] !== 0xfd && payload[0] !== 0x09) {
      throw new Error("WATERCTL INTERNAL Unknown RXD data");
    }

    // sometimes, the first one or two bytes are missing maybe due to bad firmware implementation
    // explanation: [0xFD, 0x09, ...] => [0xFD, 0xFD, 0x09, ...]
    if (payload[1] === 0x09) {
      payload = new Uint8Array([0xfd, ...payload]);
    }

    // explanation: [0x09, ...] => [0xFD, 0xFD, 0x09, ...]
    if (payload[0] === 0x09) {
      payload = new Uint8Array([0xfd, 0xfd, ...payload]);
    }

    // ... and sometimes it sends a single byte 0xFD
    if (payload.length < 4) {
      return;
    }

    const dType = payload[3];

    // https://github.com/prettier/prettier/issues/5158
    // prettier-ignore
    switch (dType) {
      case 0xB0:
      case 0xB1:
        clearTimeout(pendingStartEpilogue);
        pendingStartEpilogue = window.setTimeout(async () => {
          await writeValue(makeStartEpilogue(bluetoothdevice.name!));
        }, 500);
        break;
      case 0xAE:
        clearTimeout(pendingStartEpilogue);
        await writeValue(await makeUnlockResponse(data, bluetoothdevice.name!));
        break;
      case 0xAF:
        switch (data[5]) {
          case 0x55:
            await writeValue(makeStartEpilogue(bluetoothdevice.name!, true));
            break;
          case 0x01: // key authentication failed; "err41" (bad key)
          case 0x02: // ?
          case 0x04: // "err43" (bad nonce)
            throw new Error("WATERCTL INTERNAL Bad key");
          default:
            await writeValue(makeStartEpilogue(bluetoothdevice.name!, true));
            throw new Error("WATERCTL INTERNAL Unknown RXD data");
        }
        break;
      case 0xB2:
        clearTimeout(pendingStartEpilogue);
        clearTimeout(pendingTimeoutMessage);
        isStarted = true;
        updateUi("ok");
        break;
      case 0xB3:
        await writeValue(endEpilogue);
        await disconnect();
        break;
      case 0xBA:
        await writeValue(baAck);
        break;
      case 0xBC:
        await writeValue(offlinebombFix);
        break;
      case 0xC8:
        throw new Error("WATERCTL INTERNAL Refused");
      case 0xAA://不知道是什么，总是在第一次连接的时候出现
        console.warn("Unhandled RXD type:", dType);
        break;
      default:
        // console.warn("Unhandled RXD type:", dType);
        throw new Error("WATERCTL INTERNAL Unknown RXD data");
    }
  } catch (error) {
    handleBluetoothError(error);
  }
}

// 超时控制
function setupTimeoutMessage() {
  if (!pendingTimeoutMessage) {
    pendingTimeoutMessage = window.setTimeout(() => {
      handleBluetoothError("WATERCTL INTERNAL Operation timed out");
    }, 15000);
  }
}

// 主业务流程
let isScanning = false;
async function start() {
  if (isScanning) {
    return;
  }
  try {
    isScanning = true;
    console.log("Starting scan");
    startScan(async (devices: BleDevice[]) => {
      for (const device of devices) {
        // 记录扫描到的蓝牙设备
        log(`Scanned device: ${device.name}, address: ${device.address}`);
        if (device.name === DEVICE_NAME) {
          console.log("Found device:", device);
          stopScan();
          bluetoothdevice = device;
          updateUi("pending");
          try {
            // 添加连接错误处理
            await connect(device.address, () => {
              console.log("Disconnected");
              disconnect();
            });
          } catch (error) {
            handleBluetoothError(error);
            isScanning = false;
            return; // 提前退出
          }
          // 需要为订阅和发送操作添加错误处理
          try {
            // 订阅RXD特征
            await subscribe(RXD_UUID, handleRxdData);
            log("成功订阅RXD特征");
          } catch (subscribeError) {
            handleBluetoothError(subscribeError);
            isScanning = false;
            return;
          }

          try {
            // 发送启动序章
            await send(TXD_UUID, startPrologue);
            log("成功发送启动序章");
          } catch (sendError) {
            handleBluetoothError(sendError);
            isScanning = false;
            return;
          }
          setupTimeoutMessage();
          break;
        }
      }
      isScanning = false;
    }, 15000);

    // 直接连接指定设备
    // await connect(DEVICE_ADDRESS, () => {
    //   console.log("Disconnected");
    //   disconnect();
    // });

  } catch (error) {
    handleBluetoothError(error);
    isScanning = false;
  }
}

async function end() {
  try {
    await writeValue(endPrologue);
    setupTimeoutMessage();
  } catch (error) {
    handleBluetoothError(error);
  }
}

// 按钮事件处理
export function handleButtonClick() {
  if (isStarted) {
    end();
  } else {
    start();
  }
}

//自动重连
document.addEventListener("DOMContentLoaded", () => {
  if (autoReconnect) {
    setInterval(() => {
      const mainButton = document.getElementById("main-button") as HTMLButtonElement;
      if (mainButton.innerText == "开启") {
        start();
      }
    }, 5000);
  }
});