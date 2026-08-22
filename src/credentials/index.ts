/**
 * Заведение доступов клиента к рекламному кабинету (ТЗ § 9.1).
 *
 * До этого модуля положить секрет в систему было нечем: `buildAuthorizeUrl` и
 * `exchangeCodeForToken` не вызывались ниоткуда, а CLI, бот и сид кред не
 * заводили. Наружу торчит одна команда — `runCredentialsCommand`.
 */
export {
  credentialsUsageLines,
  runCredentialsCommand,
  CREDENTIAL_ACTIONS,
  type CredentialsAction,
  type CredentialsClient,
  type CredentialsCommandDeps,
  type CredentialsCommandOptions,
  type CredentialsStore,
  type StoredCredentialRow,
} from '@/credentials/command.js';
export {
  buildCredentialPayload,
  describeFields,
  maskSecret,
  parseProvider,
  SUPPORTED_PROVIDERS,
  type BuiltCredentialPayload,
  type CredentialField,
  type SupportedProvider,
} from '@/credentials/providers.js';
export {
  readSecret,
  MAX_SECRET_BYTES,
  SECRET_ENV_VAR,
  type ReadSecretDeps,
  type SecretSource,
  type SecretStdin,
} from '@/credentials/secret-input.js';
