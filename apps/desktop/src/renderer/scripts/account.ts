import { t } from "./i18n";
import { initShell } from "./shared";
import { mountAccount } from "./account-ui";

const { api } = initShell({ page: "account", selfTitle: t("문해 계정") });
mountAccount(api);
