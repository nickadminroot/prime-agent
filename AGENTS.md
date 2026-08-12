Это мой личный форк, не для залива в upstream.
Список отличий от upstream (поддерживай его сам):
- детерминированная компакция без LLM
- возможность выбрать reasoning у rlm
- новые заспавненные rlm наследуют контекст родителя (делают "форк")

Я использую этот форк в работе через prime-agent.sh
Поэтому при его изменениях надо обновлять и перезапускать демона тоже

## Сборка и перезапуск daemon

После изменений в исходниках:

```bash
cd /home/nickadminroot/projects/prime-agent
npm run build
```

`prime-agent.sh` по умолчанию запускает исходники через `tsx`; `--dist` использует собранный bundle. После изменения исходников daemon станет `stale`.

Для hot-restart используйте штатный coordinator обновления, но запускайте его **из отдельной tmux-сессии**, а не foreground-вызовом внутри IPython/agent worker: coordinator останавливает daemon, поэтому такой worker будет прерван до возврата tool call. Он сохраняет restart-manifest, запускает successor daemon и восстанавливает сессии. Используйте launcher этого checkout, а не `prime-agent` из `PATH` (он может быть другой версии):

```bash
ROOT=/home/nickadminroot/projects/prime-agent
STATUS="$HOME/.prime/agent/update-restarts/manual-hot-reload-$(date +%s).json"
mkdir -p "$(dirname "$STATUS")"
tmux new-session -d -s prime-agent-hot-reload   "exec $ROOT/prime-agent.sh update --internal-update-restart-coordinator \
    --daemon-socket /tmp/prime-agent-$(id -u)/daemon.sock \
    --internal-update-restart-status '$STATUS'"
# Monitor: tmux attach -t prime-agent-hot-reload
# Result:  cat "$STATUS"
$ROOT/prime-agent.sh status
```

После `phase: "complete"` в `$STATUS` в статусе должен быть один daemon `current`. Не завершайте вручную родительский `prime-agent.sh`/интерактивную сессию и не используйте `prime-agent shutdown` или `prime-agent doctor --fix` для обычного обновления: это может остановить active workers.
## Ожидаемые тестовые ограничения окружения

Некоторые тесты требуют чистого процесса и не должны запускаться с унаследованными переменными активной RLM-сессии или daemon:

```bash
env -u RLM_MAX_DEPTH -u RLM_SESSION_DIR \
  -u RLM_HARNESS_STATE_DIR -u PRIME_AGENT_INTERNAL_DAEMON_WORKER \
  -u PRIME_AGENT_INTERNAL_SESSION_LEASES \
  RLM_DEPTH=0 npx vitest run
```

Ожидаемые ограничения в рабочей WSL/Prime Agent-среде:

- RLM recursion-тесты могут получать timeout/`recursion depth limit`, если унаследованы `RLM_DEPTH`/`RLM_MAX_DEPTH`; тест проверки built-in default пропускается при заданном `RLM_MAX_DEPTH`.
- `daemon-supervisor-process.test.ts` может не пройти handshake с унаследованными `RLM_*`/`PRIME_AGENT_INTERNAL_*`; с очищенным окружением тесты проходят.
- Два Non-Wayland теста clipboard пропускаются в WSL: реализация определяет WSL по `/proc/version` и выбирает WSL-путь даже при пустом test env.
- Self-update тесты `package-command-paths.test.ts` пропускаются при активных сессиях в `~/.prime`: updater корректно отказывается обновлять пакет при занятых сессиях.
- Часть legacy passive-child тестов daemon пропускается в форке из-за наследования сессии (глубина 2 вместо upstream depth 1); queue-cap тесты upstream ожидают cap 20, а форк использует cap 100.

Оценивайте эти skips как ограничения окружения/намеренные fork-инварианты, а не как повод отключать остальные тесты. Для диагностики сначала повторяйте проблемный тест с очищенным окружением.
