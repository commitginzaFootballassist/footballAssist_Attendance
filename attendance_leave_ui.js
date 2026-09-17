/*
 * 既存の画面へ組み込む公休・有給連携ヘルパー。
 * HTML/CSS、既存のfetch、保存イベントは書き換えない。
 * このJSを読み込むだけでは画面は変わらない。FRONTEND_INTEGRATION.mdを参照。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AttendanceLeaveUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const WORK = '通常勤務';
  const HOLIDAY = '公休';
  const PAID = '有給';

  function normalizeType(value) {
    const raw = String(value == null ? '' : value).trim();
    const map = { work: WORK, holiday: HOLIDAY, paid_leave: PAID, paid: PAID };
    return map[raw.toLowerCase()] || raw;
  }

  function isLeave(value) {
    return [HOLIDAY, PAID].includes(normalizeType(value));
  }

  function choices(day) {
    if (!day || !Array.isArray(day.workTypeOptions) || day.workTypeOptions.length === 0) {
      throw new Error('勤務区分の選択肢がありません。更新版LambdaのGETレスポンスを再取得してください。');
    }
    const values = Array.from(new Set(day.workTypeOptions.map(normalizeType)));
    if (values.some(value => ![WORK, HOLIDAY, PAID].includes(value))) {
      throw new Error('勤務区分の選択肢が不正です。画面を再読込みしてください。');
    }
    return values.map(value => ({ value, label: value }));
  }

  /** 既存<select>の選択肢だけを差し替える。既存のclass/style/listenerは維持。 */
  function fillWorkTypeSelect(select, day, encodeValue = value => value) {
    if (!select || !select.ownerDocument || typeof select.appendChild !== 'function') {
      throw new TypeError('既存のselect要素を指定してください。');
    }
    const options = choices(day);
    const current = normalizeType(day.workType);
    if (current && !options.some(option => option.value === current)) {
      throw new Error('現在の勤務区分と選択肢が一致しません。保存せず再読込みしてください。');
    }
    while (select.firstChild) select.removeChild(select.firstChild);
    for (const item of options) {
      const option = select.ownerDocument.createElement('option');
      option.value = String(encodeValue(item.value));
      option.textContent = item.label;
      select.appendChild(option);
    }
    select.value = String(encodeValue(current || options[0].value));
    // changeは発火しない。既存のイベントが勝手に保存を実行することを避ける。
    return options;
  }

  /** YYYY/MM/DD または YYYY-MM-DD を、ローカルタイムゾーンに依存せず検証。 */
  function targetMonthFromDate(value) {
    const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(String(value == null ? '' : value).trim());
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1 || month < 1 || month > 12) return null;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day >= 1 && day <= days[month - 1] ? { year, month } : null;
  }

  /** targetDate省略時はpayloadの表示月/保存月。対象日を渡す利用を推奨。 */
  function gate(payload, targetDate) {
    const value = payload && payload.leavePolicy && payload.leavePolicy.punchGate;
    if (!value) {
      return { allowed: false, code: 'LEAVE_POLICY_NOT_LOADED', message: '公休・有給設定を確認中です。画面を再読込みしてください。' };
    }
    if (targetDate !== undefined && targetDate !== null) {
      const expected = targetMonthFromDate(targetDate);
      if (!expected) {
        return { allowed: false, code: 'INVALID_DATE', message: '打刻対象の日付が不正です。' };
      }
      // 9月の許可結果で10月を打刻する等、別月の判定結果を流用させない。
      if (value.scope !== 'TARGET_MONTH' || !value.target
          || value.target.year !== expected.year || value.target.month !== expected.month) {
        return { allowed: false, code: 'LEAVE_POLICY_MONTH_MISMATCH',
          message: `${expected.year}年${expected.month}月の公休・有給設定を再取得してください。別の月の判定は使用できません。` };
      }
    }
    return value;
  }

  function canPunch(payload, targetDate) {
    return gate(payload, targetDate).allowed === true;
  }

  /** 既存の「未来日/公休/打刻済み/送信中」等のdisabled判定とのORで使用する。 */
  function applyPunchButton(button, payload, disabledByExistingRules, targetDate) {
    if (!button || typeof disabledByExistingRules !== 'boolean') {
      throw new TypeError('ボタン要素と、従来条件によるdisabledの真偽値を指定してください。');
    }
    button.disabled = disabledByExistingRules || !canPunch(payload, targetDate);
    button.setAttribute('aria-disabled', String(button.disabled));
    return button.disabled;
  }

  /** UIの事前チェック。最終判定は常にLambda側で再実施する。 */
  function assertCanPunch(payload, targetDate) {
    const result = gate(payload, targetDate);
    if (result.allowed !== true) {
      const error = new Error(result.message || '打刻対象月の公休・有給設定が未完了です。');
      error.code = result.code || 'TARGET_MONTH_LEAVE_INCOMPLETE';
      throw error;
    }
  }

  function statusText(payload) {
    const policy = payload && payload.leavePolicy;
    if (!policy) return gate(payload).message;
    if (!policy.configured) return policy.error || gate(payload).message;
    const month = policy.viewMonth;
    const text = `${month.year}年${month.month}月 公休 ${month.scheduledHolidays}/${month.requiredHolidays}日・有給 ${month.scheduledPaidLeave}/${month.requiredPaidLeave}日`;
    return canPunch(payload) ? text : `${text}\n${gate(payload).message}`;
  }

  function renderStatus(element, payload) {
    if (!element) throw new TypeError('状況を表示する既存の要素を指定してください。');
    element.textContent = statusText(payload);
  }

  /** 既存の送信bodyをコピーし、有給も公休と同様に実勤務欄を空にする。 */
  function prepareAttendanceBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new TypeError('勤怠保存のbodyをオブジェクトで指定してください。');
    }
    const result = { ...body };
    const rawType = result.workType || result.attendanceType || result.type;
    if (!rawType) return result; // 従来の区分未指定・punchType互換はLambdaへ任せる。
    const type = normalizeType(rawType);
    if (![WORK, HOLIDAY, PAID].includes(type)) throw new Error('勤務区分が不正です。');
    result.workType = type;
    if (isLeave(type)) {
      if (['in', 'out'].includes(result.punchType)) {
        throw new Error('公休・有給の登録には打刻用のpunchTypeを付けないでください。');
      }
      result.inTime = '';
      result.outTime = '';
      result.breakTime = '';
      result.transport = '';
      delete result.autoBreakTimeIfEmpty;
    }
    return result;
  }

  return Object.freeze({ WORK, HOLIDAY, PAID, normalizeType, isLeave, choices,
    fillWorkTypeSelect, gate, canPunch, applyPunchButton, assertCanPunch,
    statusText, renderStatus, prepareAttendanceBody });
});
