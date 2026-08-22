/**
 * Модули команд CLI (`src/apps/cli.ts` — только разбор аргументов и диспетчер).
 *
 * Вынесены из точки входа затем, чтобы печатающие пути можно было запускать
 * тестом: `cli.ts` вызывает `main()` прямо на импорте, и всё, что живёт в нём,
 * проверяется только запуском процесса.
 */
export { cliInvocation, DEV_INVOCATION, IMAGE_INVOCATION } from '@/cli/invocation.js';
export { needsHumanFix } from '@/cli/campaign-exit.js';
export { resolveApply, type ApplyFlags } from '@/cli/flags.js';
export {
  clientsUsageLines,
  runClientsCommand,
  CLIENT_ACTIONS,
  CLIENT_STATUSES,
  type ClientListRow,
  type ClientsCommandDeps,
  type ClientsCommandOptions,
  type ExistingClient,
  type NewClient,
} from '@/cli/clients.js';
export {
  runOptimizeCommand,
  type OptimizeCampaign,
  type OptimizeCommandDeps,
  type OptimizeCommandOptions,
} from '@/cli/optimize.js';
