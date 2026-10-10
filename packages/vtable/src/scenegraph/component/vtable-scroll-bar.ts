import { ScrollBar, CustomEvent } from '@src/vrender';

/**
 * VTable 专用滚动条组件。
 *
 * 背景：当页面因多 bundle 打包/依赖版本拆分同时存在两份 @visactor/vrender-core 时，
 * vrender-components 内部（base.js `_dispatchEvent`）构造的 CustomEvent 与
 * EventTarget mixin 中 `instanceof FederatedEvent` 校验所用的类身份不一致，
 * 程序化事件派发（scrollDown/scrollDrag/scrollUp）会抛出
 * "DisplayObject cannot propagate events outside of the Federated Events API"。
 * 该异常发生在拖拽全局监听（pointermove/pointerup）注册之前，导致滚动条按住
 * 滑块后完全无反应（典型表现：多页面/微前端切换后出现，刷新页面恢复）。
 *
 * 处理：覆写 dispatchEvent，按 vrender 原实现执行但跳过类身份校验。
 * 跳过校验后的事件链路是安全的：
 * - `e.manager.dispatchEvent(e)` 走 EventManager 的树传播，与原生事件
 *   （单元格 hover/click 等在同一环境下正常）是同一条路径，不做该校验；
 * - 监听器仅读取 `e.detail` 等属性，鸭子类型调用，跨拷贝可用。
 */
export class VTableScrollBar extends ScrollBar {
  constructor(attributes: any) {
    super(attributes);
    checkVrenderEnvOnce(this);
  }

  /**
   * 复刻 vrender EventTarget.dispatchEvent（vrender-core es/event/event-target.js），
   * 仅去掉 `instanceof FederatedEvent` 强校验，其余行为保持一致。
   */
  dispatchEvent(e: any): boolean {
    e.defaultPrevented = false;
    e.path = [];
    if (e.detailPath) {
      e.detailPath = [];
    }
    e.target = this;
    e?.manager?.dispatchEvent(e);
    return !e.defaultPrevented;
  }
}

let vrenderEnvChecked = false;
/**
 * 一次性运行环境探测（仅告警，不影响功能）：
 * 1. 本模块图内，用 vrender 原版 dispatchEvent 试派发一个探测事件，
 *    若类身份校验抛错，说明 vrender-core 在模块图内被拆成了多份；
 * 2. 比较多次加载的 CustomEvent 类身份，检测页面内重复打包的 vrender-core。
 */
function checkVrenderEnvOnce(instance: VTableScrollBar) {
  if (vrenderEnvChecked) {
    return;
  }
  vrenderEnvChecked = true;
  try {
    const rawDispatch = (ScrollBar.prototype as any).dispatchEvent;
    if (typeof rawDispatch === 'function') {
      // 探测事件无监听器，且构造期 stage 未挂载（manager 为空），不会产生传播副作用
      rawDispatch.call(
        instance,
        new CustomEvent('__vtable_vrender_probe__', { detail: null })
      );
    }
    const g = globalThis as any;
    if (!g.__vtable_vrender_custom_event__) {
      g.__vtable_vrender_custom_event__ = CustomEvent;
    } else if (g.__vtable_vrender_custom_event__ !== CustomEvent) {
      console.warn(
        '[VTable] 检测到页面加载了多份 vrender-core（多应用分包或重复打包），组件程序化事件可能失效；VTableScrollBar 已做兼容，仍建议通过构建配置将 @visactor/vrender-core 收敛为单份。'
      );
    }
  } catch (e) {
    console.warn(
      '[VTable] 检测到 vrender-core 存在多份拷贝（事件类身份不一致），滚动条等组件交互会失效；VTableScrollBar 已做兼容，仍建议通过构建配置将 @visactor/vrender-core 收敛为单份。',
      e
    );
  }
}
