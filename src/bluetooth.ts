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

// 超时配置
const SCAN_TIMEOUT = 15000;
const CONNECTION_TIMEOUT = 10000;
const RECONNECT_DELAY = 400;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BACKOFF_MULTIPLIER = 1.5;
const DIALOG_AUTO_CLOSE_DELAY = 3000;
const DUPLICATE_CLEANUP_DELAY = 5000;
const START_EPILOGUE_DELAY = 500;
const HEARTBEAT_INTERVAL = 30000; // 30秒心跳检测

// 连接状态枚举
enum ConnectionStage {
  STANDBY = "standby",
  SCANNING = "scanning",
  CONNECTING = "connecting", 
  CONNECTED = "connected",
  READY = "ready",
  ERROR = "error"
}

// 蓝牙设备状态管理
class BluetoothManager {
  private device: BleDevice | null = null;
  private isStarted = false;
  private autoReconnect = true;
  private currentStage: ConnectionStage = ConnectionStage.STANDBY;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private connectionTimeout: number | null = null;
  private pendingStartEpilogue: number | null = null;
  private pendingTimeoutMessage: number | null = null;
  private countdown: CountdownController | null = null;
  private recentDataMap = new Map<string, number>();
  private readonly MAX_DUPLICATE_COUNT = 2;
  private lastDataTimestamp = 0;
  private isConnectionHealthy = false;

  // 获取当前连接状态
  getConnectionStage(): ConnectionStage {
    return this.currentStage;
  }

  // 设置连接状态
  private setConnectionStage(stage: ConnectionStage): void {
    this.currentStage = stage;
    log(`连接状态变更: ${stage}`);
  }

  // 检查连接健康状态
  private checkConnectionHealth(): boolean {
    const now = Date.now();
    const timeSinceLastData = now - this.lastDataTimestamp;
    
    // 如果超过心跳间隔没有收到数据，认为连接不健康
    if (this.lastDataTimestamp > 0 && timeSinceLastData > HEARTBEAT_INTERVAL) {
      this.isConnectionHealthy = false;
      log(`连接健康检查失败: ${timeSinceLastData}ms 未收到数据`);
      return false;
    }
    
    this.isConnectionHealthy = true;
    return true;
  }

  // 启动心跳检测
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.checkConnectionHealth()) {
        log("连接不健康，尝试重连");
        this.handleConnectionLoss();
      }
    }, HEARTBEAT_INTERVAL);
  }

  // 停止心跳检测
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // 处理连接丢失
  private async handleConnectionLoss(): Promise<void> {
    log("检测到连接丢失");
    this.isConnectionHealthy = false;
    this.stopHeartbeat();
    
    if (this.autoReconnect && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      await this.scheduleReconnect();
    } else {
      await this.disconnect();
    }
  }

  // 安排重连
  private async scheduleReconnect(): Promise<void> {
    this.reconnectAttempts++;
    const delay = RECONNECT_DELAY * Math.pow(RECONNECT_BACKOFF_MULTIPLIER, this.reconnectAttempts - 1);
    
    log(`安排重连 (尝试 ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})，延迟: ${delay}ms`);
    
    this.reconnectTimer = window.setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.autoReconnect && this.currentStage !== ConnectionStage.STANDBY) {
        await this.start();
      }
    }, delay);
  }

  // 重置重连计数
  private resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // 设置连接超时
  private setupConnectionTimeout(): void {
    this.clearConnectionTimeout();
    this.connectionTimeout = window.setTimeout(() => {
      log("连接超时");
      this.handleConnectionLoss();
    }, CONNECTION_TIMEOUT);
  }

  // 清除连接超时
  private clearConnectionTimeout(): void {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
  }

  // 写入数据到设备（带重试）
  private async writeValue(value: Uint8Array, retryCount = 3): Promise<void> {
    const msg = "TXD: " + bufferToHexString(value);
    log(msg);
    
    for (let attempt = 1; attempt <= retryCount; attempt++) {
      try {
        await send(TXD_UUID, value);
        log(`数据发送成功 (尝试 ${attempt}/${retryCount})`);
        return;
      } catch (error: unknown) {
        log(`数据发送失败 (尝试 ${attempt}/${retryCount}): ${error}`);
        
        if (attempt === retryCount) {
          throw error;
        }
        
        // 等待一段时间后重试
        await new Promise(resolve => setTimeout(resolve, 100 * attempt));
      }
    }
  }

  // 更新UI状态
  updateUi(stage: ConnectionStage): void {
    const mainButton = document.getElementById("main-button") as HTMLButtonElement;
    const deviceName = document.getElementById("device-name") as HTMLSpanElement;
    const counterElement = document.getElementById("counter") as HTMLElement;

    if (!mainButton || !deviceName) {
      console.error("UI elements not found");
      return;
    }

    switch (stage) {
      case ConnectionStage.SCANNING:
      case ConnectionStage.CONNECTING:
        mainButton.textContent = "请稍候";
        mainButton.disabled = true;
        deviceName.textContent = `连接中：${this.device?.name || "未知设备"}`;
        break;
      case ConnectionStage.CONNECTED:
        mainButton.textContent = "请稍候";
        mainButton.disabled = true;
        deviceName.textContent = `已连接：${this.device?.name || "未知设备"}`;
        break;
      case ConnectionStage.READY:
        mainButton.textContent = "结束";
        mainButton.disabled = false;
        this.countdown = startCountdown(420, counterElement, () => {
          console.log("时间到！");
        });
        break;
      case ConnectionStage.STANDBY:
      case ConnectionStage.ERROR:
        mainButton.textContent = "开启";
        mainButton.disabled = false;
        deviceName.textContent = "未连接";
        if (this.countdown) {
          this.countdown.stop();
          this.countdown = null;
        }
        break;
    }
  }

  // 清理超时定时器
  private clearTimeouts(): void {
    if (this.pendingStartEpilogue) {
      clearTimeout(this.pendingStartEpilogue);
      this.pendingStartEpilogue = null;
    }
    if (this.pendingTimeoutMessage) {
      clearTimeout(this.pendingTimeoutMessage);
      this.pendingTimeoutMessage = null;
    }
    this.clearConnectionTimeout();
    this.stopHeartbeat();
  }

  // 断开连接
  async disconnect(): Promise<void> {
    try {
      if (this.device?.isConnected) {
        await bleDisconnect();
      }
    } catch (error: unknown) {
      console.error("断开连接错误:", error);
    }
    
    this.isStarted = false;
    this.device = null;
    this.isConnectionHealthy = false;
    this.lastDataTimestamp = 0;
    clearLogs();
    this.clearTimeouts();
    this.resetReconnectAttempts();
    this.setConnectionStage(ConnectionStage.STANDBY);
    this.updateUi(ConnectionStage.STANDBY);
  }

  // 错误处理
  async handleBluetoothError(error: unknown): Promise<void> {
    if (!error) return;

    const errorString = error.toString();
    log(`蓝牙错误: ${errorString}`);

    // 忽略用户取消操作
    if (errorString.match(/User cancelled/) || errorString === "2") {
      return;
    }

    // 根据错误类型决定处理策略
    const errorType = this.classifyError(errorString);
    
    switch (errorType) {
      case 'connection_lost':
        await this.handleConnectionError();
        break;
      case 'timeout':
        await this.handleTimeoutError();
        break;
      case 'permission':
        await this.handlePermissionError();
        break;
      case 'device_not_found':
        await this.handleDeviceNotFoundError();
        break;
      default:
        await this.handleGenericError(error);
        break;
    }
  }

  // 错误分类
  private classifyError(errorString: string): string {
    if (errorString.includes('timeout') || errorString.includes('timed out')) {
      return 'timeout';
    }
    if (errorString.includes('permission') || errorString.includes('denied')) {
      return 'permission';
    }
    if (errorString.includes('not found') || errorString.includes('device not found')) {
      return 'device_not_found';
    }
    if (errorString.includes('disconnect') || errorString.includes('connection lost')) {
      return 'connection_lost';
    }
    return 'generic';
  }

  // 处理连接错误
  private async handleConnectionError(): Promise<void> {
    log("处理连接错误");
    this.setConnectionStage(ConnectionStage.ERROR);
    this.updateUi(ConnectionStage.ERROR);
    
    if (this.autoReconnect && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      await this.scheduleReconnect();
    } else {
      await this.showErrorDialog("连接错误", "设备连接失败，请检查设备是否在范围内并重试。");
      await this.disconnect();
    }
  }

  // 处理超时错误
  private async handleTimeoutError(): Promise<void> {
    log("处理超时错误");
    this.setConnectionStage(ConnectionStage.ERROR);
    this.updateUi(ConnectionStage.ERROR);
    
    await this.showErrorDialog("连接超时", "设备响应超时，请检查设备状态并重试。");
    
    if (this.autoReconnect && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      await this.scheduleReconnect();
    } else {
      await this.disconnect();
    }
  }

  // 处理权限错误
  private async handlePermissionError(): Promise<void> {
    log("处理权限错误");
    this.setConnectionStage(ConnectionStage.ERROR);
    this.updateUi(ConnectionStage.ERROR);
    
    await this.showErrorDialog("权限错误", "蓝牙权限被拒绝，请在系统设置中启用蓝牙权限。");
    await this.disconnect();
  }

  // 处理设备未找到错误
  private async handleDeviceNotFoundError(): Promise<void> {
    log("处理设备未找到错误");
    this.setConnectionStage(ConnectionStage.ERROR);
    this.updateUi(ConnectionStage.ERROR);
    
    await this.showErrorDialog("设备未找到", "未找到目标设备，请确保设备已开启并在范围内。");
    
    if (this.autoReconnect && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      await this.scheduleReconnect();
    } else {
      await this.disconnect();
    }
  }

  // 处理通用错误
  private async handleGenericError(error: unknown): Promise<void> {
    log("处理通用错误");
    this.setConnectionStage(ConnectionStage.ERROR);
    this.updateUi(ConnectionStage.ERROR);
    
    await this.showErrorDialog("连接错误", `发生未知错误: ${error}`);
    
    if (this.autoReconnect && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      await this.scheduleReconnect();
    } else {
      await this.disconnect();
    }
  }

  // 显示错误对话框
  private async showErrorDialog(title: string, message: string): Promise<void> {
    const dialogContent = document.getElementById("dialog-content") as HTMLParagraphElement;
    const dialogDebugContainer = document.getElementById("dialog-debug-container") as HTMLPreElement;
    const dialogDebugContent = document.getElementById("dialog-debug-content");

    if (!dialogContent || !dialogDebugContainer || !dialogDebugContent) {
      console.error("Dialog elements not found");
      return;
    }

    // 显示错误信息
    dialogContent.textContent = message;

    // 显示调试信息
    dialogDebugContainer.style.display = "none";
    if (!isLogEmpty()) {
      dialogDebugContainer.style.display = "block";
      dialogDebugContent.textContent = "调试信息：\n" + getLogs().join("\n");
    }

    const dialog = document.getElementById("dialog") as HTMLDialogElement;
    if (dialog) {
      dialog.showModal();

      // 自动关闭对话框
      if (this.autoReconnect) {
        setTimeout(() => {
          dialog.close();
        }, DIALOG_AUTO_CLOSE_DELAY);
      }
    }
  }

  // 设置超时消息
  private setupTimeoutMessage(): void {
    if (!this.pendingTimeoutMessage) {
      this.pendingTimeoutMessage = window.setTimeout(() => {
        this.handleBluetoothError("WATERCTL INTERNAL Operation timed out");
      }, SCAN_TIMEOUT);
    }
  }

  // 处理重复数据
  private isDuplicateData(data: Uint8Array): boolean {
    const dataKey = bufferToHexString(data);
    const currentCount = this.recentDataMap.get(dataKey) || 0;

    if (currentCount >= this.MAX_DUPLICATE_COUNT - 1) {
      log(`忽略重复数据: ${dataKey} (第${currentCount + 1}次)`);
      return true;
    }

    this.recentDataMap.set(dataKey, currentCount + 1);

    // 清理过期数据
    setTimeout(() => {
      this.recentDataMap.delete(dataKey);
    }, DUPLICATE_CLEANUP_DELAY);

    return false;
  }

  // 处理RXD数据
  async handleRxdData(data: Uint8Array): Promise<void> {
    // 更新最后数据时间戳
    this.lastDataTimestamp = Date.now();
    
    // 检查重复数据
    if (this.isDuplicateData(data)) {
      return;
    }

    log("RXD: " + bufferToHexString(data));

    try {
      let payload = new Uint8Array(data);

      // 忽略AT命令
      if (payload[0] === 0x41 && payload[1] === 0x54 && payload[2] === 0x2b) {
        log("忽略AT命令");
        return;
      }

      if (payload[0] !== 0xfd && payload[0] !== 0x09) {
        log(`无效数据格式: 0x${payload[0].toString(16)}`);
        throw new Error("WATERCTL INTERNAL Unknown RXD data");
      }

      // 修复固件bug导致的数据缺失
      if (payload[1] === 0x09) {
        payload = new Uint8Array([0xfd, ...payload]);
        log("修复数据格式: 添加前导0xFD");
      }

      if (payload[0] === 0x09) {
        payload = new Uint8Array([0xfd, 0xfd, ...payload]);
        log("修复数据格式: 添加双前导0xFD");
      }

      if (payload.length < 4) {
        log("数据长度不足，忽略");
        return;
      }

      const dType = payload[3];
      log(`处理数据类型: 0x${dType.toString(16)}`);
      await this.processRxdType(dType, data, payload);
    } catch (error: unknown) {
      log(`处理RXD数据失败: ${error}`);
      await this.handleBluetoothError(error);
    }
  }

  // 处理RXD数据类型
  private async processRxdType(dType: number, data: Uint8Array, payload: Uint8Array): Promise<void> {
    try {
      switch (dType) {
        case 0xB0:
        case 0xB1:
          log(`收到启动序章响应: 0x${dType.toString(16)}`);
          this.clearTimeouts();
          this.pendingStartEpilogue = window.setTimeout(async () => {
            try {
              await this.writeValue(makeStartEpilogue(this.device?.name || ""));
              log("发送启动尾声");
            } catch (error: unknown) {
              log(`发送启动尾声失败: ${error}`);
              await this.handleBluetoothError(error);
            }
          }, START_EPILOGUE_DELAY);
          break;

        case 0xAE:
          log("收到解锁请求");
          this.clearTimeouts();
          try {
            await this.writeValue(await makeUnlockResponse(data, this.device?.name || ""));
            log("发送解锁响应");
          } catch (error: unknown) {
            log(`发送解锁响应失败: ${error}`);
            throw error;
          }
          break;

        case 0xAF:
          await this.handleAuthResponse(data[5]);
          break;

        case 0xB2:
          log("收到启动确认");
          this.clearTimeouts();
          this.isStarted = true;
          this.setConnectionStage(ConnectionStage.READY);
          this.updateUi(ConnectionStage.READY);
          break;

        case 0xB3:
          log("收到结束请求");
          try {
            await this.writeValue(endEpilogue);
            log("发送结束尾声");
          } catch (error: unknown) {
            log(`发送结束尾声失败: ${error}`);
          }
          await this.disconnect();
          break;

        case 0xAA: // telemetry
          log("收到遥测数据");
          break;
        case 0xB5: // temperature settings
          log("收到温度设置数据");
          break;
        case 0xB8: // unknown
          log("收到未知数据");
          break;

        case 0xBA:
          log("收到BA确认");
          try {
            await this.writeValue(baAck);
            log("发送BA确认响应");
          } catch (error: unknown) {
            log(`发送BA确认响应失败: ${error}`);
            throw error;
          }
          break;

        case 0xBC:
          log("收到离线炸弹修复");
          try {
            await this.writeValue(offlinebombFix);
            log("发送离线炸弹修复响应");
          } catch (error: unknown) {
            log(`发送离线炸弹修复响应失败: ${error}`);
            throw error;
          }
          break;

        case 0xC8:
          log("收到拒绝响应");
          throw new Error("WATERCTL INTERNAL Refused");

        default:
          log(`未处理的数据类型: 0x${dType.toString(16)}`);
          throw new Error("WATERCTL INTERNAL Unknown RXD data");
      }
    } catch (error: unknown) {
      log(`处理数据类型 0x${dType.toString(16)} 失败: ${error}`);
      throw error;
    }
  }

  // 处理认证响应
  private async handleAuthResponse(responseCode: number): Promise<void> {
    try {
      switch (responseCode) {
        case 0x55:
          await this.writeValue(makeStartEpilogue(this.device?.name || "", true));
          break;
        case 0x01: // key authentication failed
        case 0x02: // unknown error
        case 0x04: // bad nonce
          log(`认证失败，响应码: 0x${responseCode.toString(16)}`);
          throw new Error("WATERCTL INTERNAL Bad key");
        default:
          await this.writeValue(makeStartEpilogue(this.device?.name || "", true));
          log(`未知认证响应码: 0x${responseCode.toString(16)}`);
          throw new Error("WATERCTL INTERNAL Unknown RXD data");
      }
    } catch (error: unknown) {
      log(`处理认证响应失败: ${error}`);
      throw error;
    }
  }

  // 连接设备
  private async connectDevice(device: BleDevice): Promise<void> {
    this.device = device;
    this.setConnectionStage(ConnectionStage.CONNECTING);
    this.updateUi(ConnectionStage.CONNECTING);
    this.setupConnectionTimeout();

    try {
      log(`尝试连接设备: ${device.name} (${device.address})`);
      
      await connect(device.address, () => {
        console.log("设备断开连接");
        this.handleConnectionLoss();
      });

      log("成功连接设备");
      this.clearConnectionTimeout();
      this.setConnectionStage(ConnectionStage.CONNECTED);
      this.updateUi(ConnectionStage.CONNECTED);

      // 订阅RXD特征
      log("订阅RXD特征...");
      await subscribe(RXD_UUID, (data: Uint8Array) => this.handleRxdData(data));
      log("成功订阅RXD特征");

      // 发送启动序章
      log("发送启动序章...");
      await this.writeValue(startPrologue);
      log("成功发送启动序章");

      // 启动心跳检测
      this.startHeartbeat();
      log("启动心跳检测");

    } catch (error: unknown) {
      log(`连接设备失败: ${error}`);
      this.clearConnectionTimeout();
      this.setConnectionStage(ConnectionStage.ERROR);
      this.updateUi(ConnectionStage.ERROR);
      await this.handleBluetoothError(error);
    }
  }

  // 开始扫描和连接
  async start(): Promise<void> {
    if (this.currentStage === ConnectionStage.SCANNING || 
        this.currentStage === ConnectionStage.CONNECTING) {
      console.log("正在扫描或连接中...");
      return;
    }

    try {
      this.setConnectionStage(ConnectionStage.SCANNING);
      this.updateUi(ConnectionStage.SCANNING);
      console.log("开始扫描蓝牙设备...");

      let deviceFound = false;
      
      await new Promise<void>((resolve, reject) => {
        const scanTimeout = setTimeout(() => {
          console.log("扫描超时");
          if (!deviceFound) {
            this.setConnectionStage(ConnectionStage.ERROR);
            this.updateUi(ConnectionStage.ERROR);
            this.handleConnectionLoss();
          }
          resolve();
        }, SCAN_TIMEOUT);

        startScan((devices: BleDevice[]) => {
          for (const device of devices) {
            console.log(`扫描到设备: ${device.name}, 地址: ${device.address}`);
            if (device.name === DEVICE_NAME) {
              console.log("找到目标设备:", device);
              deviceFound = true;
              clearTimeout(scanTimeout);
              stopScan();
              this.connectDevice(device).then(resolve).catch(reject);
              return;
            }
          }
        }, SCAN_TIMEOUT);
      });

    } catch (error: unknown) {
      log(`启动失败: ${error}`);
      this.setConnectionStage(ConnectionStage.ERROR);
      this.updateUi(ConnectionStage.ERROR);
      await this.handleBluetoothError(error);
    }
  }

  // 结束操作
  async end(): Promise<void> {
    try {
      log("开始结束操作...");
      await this.writeValue(endPrologue);
      log("发送结束序章成功");
      this.setupTimeoutMessage();
    } catch (error: unknown) {
      log(`结束操作失败: ${error}`);
      await this.handleBluetoothError(error);
    }
  }

  // 按钮点击处理
  handleButtonClick(): void {
    if (this.isStarted) {
      log("用户点击结束按钮");
      this.end();
    } else {
      log("用户点击开始按钮");
      this.start();
    }
  }
}

// 创建全局蓝牙管理器实例
const bluetoothManager = new BluetoothManager();

// 导出按钮处理函数
export function handleButtonClick(): void {
  bluetoothManager.handleButtonClick();
}