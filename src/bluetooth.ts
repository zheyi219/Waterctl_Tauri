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

// 重试配置
const MAX_RETRY_COUNT = 3;
const RETRY_DELAY = 1000; // 1秒
const CONNECTION_TIMEOUT = 10000; // 10秒连接超时
const OPERATION_TIMEOUT = 15000; // 15秒操作超时

let bluetoothdevice: BleDevice;

// 状态变量
let isStarted = false;
let autoReconnect = true;
let connectionAttempts = 0;
let lastDisconnectTime = 0;
let reconnectTimer: number | null = null;
let isManualDisconnect = false;

let pendingStartEpilogue: number; // workaround for determining new firmware, see handleRxdNotifications
let pendingTimeoutMessage: number; // if we don't get a response in time, we should show an error message

let countdown: CountdownController; //prepare for the countdown

// 连接质量监控
interface ConnectionQuality {
  signalStrength: number;
  errorCount: number;
  lastSuccessTime: number;
  consecutiveFailures: number;
}

let connectionQuality: ConnectionQuality = {
  signalStrength: 0,
  errorCount: 0,
  lastSuccessTime: Date.now(),
  consecutiveFailures: 0
};

// 带重试机制的发送函数
async function writeValueWithRetry(value: Uint8Array, retryCount = 0): Promise<void> {
  const msg = "TXD: " + bufferToHexString(value);
  log(msg);
  
  try {
    await send(TXD_UUID, value);
    connectionQuality.lastSuccessTime = Date.now();
    connectionQuality.consecutiveFailures = 0;
  } catch (error) {
    connectionQuality.errorCount++;
    connectionQuality.consecutiveFailures++;
    
    if (retryCount < MAX_RETRY_COUNT) {
      log(`发送失败，正在重试 (${retryCount + 1}/${MAX_RETRY_COUNT}): ${error}`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (retryCount + 1)));
      return writeValueWithRetry(value, retryCount + 1);
    } else {
      log(`发送失败，已达到最大重试次数: ${error}`);
      throw error;
    }
  }
}

// 向后兼容的函数
async function writeValue(value: Uint8Array) {
  return writeValueWithRetry(value);
}

// 带重试机制的订阅函数
async function subscribeWithRetry(uuid: string, callback: (data: Uint8Array) => void, retryCount = 0): Promise<void> {
  try {
    await subscribe(uuid, callback);
    connectionQuality.lastSuccessTime = Date.now();
    connectionQuality.consecutiveFailures = 0;
    log(`成功订阅 ${uuid}`);
  } catch (error) {
    connectionQuality.errorCount++;
    connectionQuality.consecutiveFailures++;
    
    if (retryCount < MAX_RETRY_COUNT) {
      log(`订阅失败，正在重试 (${retryCount + 1}/${MAX_RETRY_COUNT}): ${error}`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (retryCount + 1)));
      return subscribeWithRetry(uuid, callback, retryCount + 1);
    } else {
      log(`订阅失败，已达到最大重试次数: ${error}`);
      throw error;
    }
  }
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
      if (countdown) countdown.stop();
      break;
  }
}

// 智能断连逻辑
function shouldReconnect(): boolean {
  const now = Date.now();
  const timeSinceLastDisconnect = now - lastDisconnectTime;
  
  // 如果是手动断连，不自动重连
  if (isManualDisconnect) {
    return false;
  }
  
  // 如果连续失败次数过多，延长重连间隔
  if (connectionQuality.consecutiveFailures >= 5) {
    return timeSinceLastDisconnect > 30000; // 30秒后再重连
  }
  
  // 如果错误率过高，延长重连间隔
  if (connectionQuality.errorCount > 10) {
    return timeSinceLastDisconnect > 10000; // 10秒后再重连
  }
  
  // 正常情况下的重连间隔
  return timeSinceLastDisconnect > 2000; // 2秒后重连
}

// 计算重连延迟
function getReconnectDelay(): number {
  const baseDelay = 2000; // 基础延迟2秒
  const maxDelay = 30000; // 最大延迟30秒
  
  // 根据连接尝试次数计算指数退避延迟
  const exponentialDelay = Math.min(baseDelay * Math.pow(2, connectionAttempts), maxDelay);
  
  // 根据连接质量调整延迟
  const qualityMultiplier = Math.max(1, connectionQuality.consecutiveFailures * 0.5);
  
  return Math.min(exponentialDelay * qualityMultiplier, maxDelay);
}

// 优化的断开连接处理
async function disconnect(manual: boolean = false) {
  isManualDisconnect = manual;
  lastDisconnectTime = Date.now();
  
  // 清除重连定时器
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  try {
    if (bluetoothdevice && bluetoothdevice.isConnected) {
      log("正在断开连接...");
      await bleDisconnect();
      log("连接已断开");
    }
  } catch (error) {
    console.error("Disconnect error:", error);
    log(`断开连接时出错: ${error}`);
  }
  
  isStarted = false;
  if (manual) {
    clearLogs();
  }
  clearAllTimers();
  updateUi("standby");

  // 智能重连逻辑
  if (autoReconnect && !manual && shouldReconnect()) {
    const delay = getReconnectDelay();
    log(`将在 ${delay/1000} 秒后尝试重连...`);
    
    reconnectTimer = window.setTimeout(() => {
      if (autoReconnect && !isManualDisconnect) {
        connectionAttempts++;
        log(`开始第 ${connectionAttempts} 次重连尝试`);
        start();
      }
    }, delay);
  } else if (!manual) {
    log("暂停自动重连，连接质量较差或重连过于频繁");
  }
}

// 错误处理
async function handleBluetoothError(error: unknown) {
  // this is so fucking ugly but i have no choice
  // you would never know how those shitty browsers behave
  if (!error) throw error;

  const e = error.toString();

  if (e.match(/User cancelled/) || e == "2") {
    // "2" is a weird behavior of Bluefy browser on iOS
    return;
  }

  const dialogContent = document.getElementById("dialog-content") as HTMLParagraphElement;
  const dialogDebugContainer = document.getElementById("dialog-debug-container") as HTMLPreElement;
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

  if (isFatal || autoReconnect) await disconnect(false);
}

// RXD数据处理
// 用于存储最近接收到的数据及其出现次数
const recentDataMap = new Map<string, number>();
// 最大重复次数
const MAX_DUPLICATE_COUNT = 2;

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
        await disconnect(false);
        break;
      case 0xAA: // telemetry, no need to respond
      case 0xB5: // temperature settings related, no need to respond
      case 0xB8: // unknown, no need to respond
        break;
      case 0xBA:
        await writeValue(baAck);
        break;
      case 0xBC:
        await writeValue(offlinebombFix);
        break;
      case 0xC8:
        throw new Error("WATERCTL INTERNAL Refused");
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
    }, OPERATION_TIMEOUT);
  }
}

// 清除所有定时器
function clearAllTimers() {
  if (pendingStartEpilogue) {
    clearTimeout(pendingStartEpilogue);
    pendingStartEpilogue = 0;
  }
  if (pendingTimeoutMessage) {
    clearTimeout(pendingTimeoutMessage);
    pendingTimeoutMessage = 0;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// 连接超时处理
function createConnectionTimeout(): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error("WATERCTL INTERNAL Connection timeout"));
    }, CONNECTION_TIMEOUT);
  });
}

// 主业务流程
let isScanning = false;
let isConnecting = false;
async function start() {
  if (isScanning || isConnecting) {
    console.log("Scanning or connecting...");
    return;
  }
  
  try {
    isScanning = true;
    log("开始扫描设备...");
    
    const scanPromise = new Promise<BleDevice | null>((resolve) => {
      startScan((devices: BleDevice[]) => {
        for (const device of devices) {
          console.log(`Scanned device: ${device.name}, address: ${device.address}`);
          if (device.name === DEVICE_NAME) {
            console.log("Found device:", device);
            stopScan();
            resolve(device);
            return;
          }
        }
      }, 15000)
        .then(() => {
          console.log("Scan completed");
          resolve(null);
        })
        .catch((error: unknown) => {
          console.error("Scan error:", error);
          resolve(null);
        });
    });

    const device = await scanPromise;
    isScanning = false;

    if (!device) {
      log("未找到目标设备");
      await disconnect(false);
      return;
    }

    bluetoothdevice = device;
    updateUi("pending");
    isConnecting = true;
    
    try {
      // 使用超时机制的连接
      await Promise.race([
        connect(device.address, () => {
          console.log("Disconnected");
          disconnect(false);
        }),
        createConnectionTimeout()
      ]);

      log("成功连接设备");
      isConnecting = false;
      
      // 重置连接质量统计
      connectionQuality.lastSuccessTime = Date.now();
      connectionQuality.consecutiveFailures = 0;
      connectionAttempts = 0; // 重置连接尝试次数

      // 使用带重试的订阅
      await subscribeWithRetry(RXD_UUID, handleRxdData);

      // 使用带重试的发送
      await writeValueWithRetry(startPrologue);
      log("成功发送启动序章");

      setupTimeoutMessage();

    } catch (error) {
      isConnecting = false;
      isScanning = false;
      log(`连接或初始化失败: ${error}`);
      handleBluetoothError(error);
    }

  } catch (error) {
    isScanning = false;
    isConnecting = false;
    log(`启动过程出错: ${error}`);
    handleBluetoothError(error);
  }
}

async function end() {
  try {
    await writeValueWithRetry(endPrologue);
    setupTimeoutMessage();
  } catch (error) {
    handleBluetoothError(error);
  }
}

// 手动断开连接
export function manualDisconnect() {
  isManualDisconnect = true;
  autoReconnect = false;
  disconnect(true);
}

// 启用自动重连
export function enableAutoReconnect() {
  autoReconnect = true;
  isManualDisconnect = false;
  connectionQuality.consecutiveFailures = 0;
  connectionAttempts = 0;
}

// 获取连接状态
export function getConnectionStatus() {
  return {
    isConnected: bluetoothdevice?.isConnected || false,
    isStarted,
    connectionQuality,
    connectionAttempts,
    autoReconnect,
    isManualDisconnect
  };
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
// document.addEventListener("DOMContentLoaded", () => {
//   if (autoReconnect) {
//     setInterval(() => {
//       const mainButton = document.getElementById("main-button") as HTMLButtonElement;
//       if (mainButton.innerText == "开启") {
//         start();
//       }
//     }, 5000);
//   }
// });