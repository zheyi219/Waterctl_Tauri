// 倒计时控制器接口
export interface CountdownController {
    stop: () => void;
    pause: () => void;
    resume: () => void;
}

// 用于记录每个元素对应的倒计时控制器
const elementCountdownMap = new Map<HTMLElement, CountdownController>();

export function startCountdown(durationSeconds: number, updateElement: HTMLElement, onComplete?: () => void): CountdownController {
    // 如果该元素已经有倒计时在运行，停止它
    if (elementCountdownMap.has(updateElement)) {
        elementCountdownMap.get(updateElement)?.stop();
        elementCountdownMap.delete(updateElement);
    }

    let remaining = durationSeconds; // 剩余时间
    let intervalId: number; // 计时器 ID
    let paused = false; // 是否暂停
    let pauseTime: number; // 暂停时的时间戳

    // 格式化时间为 mm:ss
    const formatTime = (seconds: number): string => {
        const mins = Math.floor(seconds / 60)
            .toString()
            .padStart(2, "0");
        const secs = (seconds % 60).toString().padStart(2, "0");
        return `${mins}:${secs}`;
    };

    // 更新 DOM
    const updateDisplay = () => {
        updateElement.textContent = `剩余时间：${formatTime(remaining)}`;
        // 在 updateDisplay 中添加
        if (remaining <= 120) {
            updateElement.classList.add("low-time");
        } else {
            updateElement.classList.remove("low-time");
        }
    };

    // 启动计时器
    const startTimer = () => {
        intervalId = window.setInterval(() => {
            if (!paused) {
                remaining--;
                updateDisplay();

                if (remaining <= 0) {
                    clearInterval(intervalId);
                    onComplete?.();
                    elementCountdownMap.delete(updateElement);
                }
            }
        }, 1000);
    };

    // 初始化显示
    updateDisplay();
    startTimer();

    const controller: CountdownController = {
        stop: () => {
            clearInterval(intervalId);
            updateElement.textContent = "剩余时间：00:00";
            elementCountdownMap.delete(updateElement);
        },
        pause: () => {
            if (!paused) {
                paused = true;
                pauseTime = Date.now(); // 记录暂停时的时间
            }
        },
        resume: () => {
            if (paused) {
                paused = false;
                const now = Date.now();
                const pausedDuration = Math.floor((now - pauseTime) / 1000); // 计算暂停时长
                remaining -= pausedDuration; // 调整剩余时间
                updateDisplay();
            }
        },
    };

    // 记录该元素对应的倒计时控制器
    elementCountdownMap.set(updateElement, controller);

    return controller;
}

// 使用示例 (7分钟 = 420秒)
// const counterElement = document.getElementById("counter") as HTMLElement;
// const countdown = startCountdown(420, counterElement, () => {
//     alert("时间到！");
// });

// 暂停倒计时
// countdown.pause();

// 恢复倒计时
// countdown.resume();

// 停止倒计时
// countdown.stop();