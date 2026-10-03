// Helm fork: texts of agent alerts sent by the Volna core, which does not know
// the phone's language. The core sends these keys (loc-key / title-loc-key,
// Volna core/src/helm/aggregate.ts); iOS fills them from Localizable.strings.
// Keep the keys in step with the core.
export const HELM_ALERT_STRINGS = {
  en: {
    HELM_ALERT_APPROVAL: "Approval needed: %@",
    HELM_ALERT_INPUT: "Waiting for input: %@",
    HELM_ALERT_DONE: "Done: %@",
    HELM_ALERT_FAILED: "Failed: %@",
    HELM_ALERT_MANY_WAITING: "%@ agents need attention",
    HELM_ALERT_MANY_DONE: "%@ agents finished",
  },
  ru: {
    HELM_ALERT_APPROVAL: "Ждёт разрешения: %@",
    HELM_ALERT_INPUT: "Ждёт ответа: %@",
    HELM_ALERT_DONE: "Готово: %@",
    HELM_ALERT_FAILED: "Ошибка: %@",
    HELM_ALERT_MANY_WAITING: "Агенты ждут тебя: %@",
    HELM_ALERT_MANY_DONE: "Агенты закончили: %@",
  },
} as const;
