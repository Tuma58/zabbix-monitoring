# Спецификация dashboard и настроек

## Принципы интерфейса

Визуальная система наследует сайт CoreSupport: Plus Jakarta Sans, фон `#FAF8F5`,
индиго `#3D5A80`/`#5B7B9A`, терракоту `#C17A6C`, зелёный `#7A9E7E`, полупрозрачные
карточки, мягкие тени и скругления 12–18 px. Логотип с концентрическими кольцами
используется без изменения геометрии. Рабочий прототип находится в
[`dashboard/`](../dashboard/).

- оператор сначала видит отклонения, затем общую статистику;
- цвет не является единственным носителем статуса: используются иконка и текст;
- каждый показатель содержит время последнего обновления и источник;
- переход из агрегата всегда ведёт к отфильтрованному списку объектов;
- небезопасные или необратимые действия требуют preview и подтверждения;
- UI не показывает SNMP community, PSK, IPMI password даже администратору.

## Главный dashboard

### Верхняя панель

- глобальный поиск по имени, IP, serial, inventory и tag;
- фильтры: площадка, группа, тип, status, severity и tag;
- индикатор связи с backend/Zabbix и возраст данных;
- выбор периода: 1 час, 24 часа, 7/30 дней.

### Виджеты первой строки

1. **Доступность** — available/unknown/unavailable hosts с переходом в каталог.
2. **Активные проблемы** — Disaster/High/Average/Warning с динамикой.
3. **Новые за 24 часа** — проблемы и недавно восстановленные события.
4. **Мониторинг не настроен** — hosts без данных, unsupported items, failed probes.

### Основная область

- таблица текущих проблем: severity, duration, host, site, summary, ack, owner;
- состояние площадок: количество проблем, availability и proxy last seen;
- network/compute/UPS health по типам устройств;
- capacity: disk forecast, UPS runtime/load, interface utilization, CPU/RAM;
- top noisy devices за период;
- последние изменения конфигурации из audit log.

Все виджеты используют согласованные фильтры. Пользователь может скрывать и
переставлять виджеты; layout хранится в профиле, но набор доступных widget types
ограничивается permission-ами.

## Карточка устройства

### Summary

Status, address, site, proxy, тип, vendor/model, serial, uptime, templates, tags,
последние данные и открытые проблемы. Есть быстрые действия: maintenance,
повторный probe, синхронизация и переход в административный Zabbix UI.

### Metrics

- вычислительная техника: CPU, RAM, filesystems, services/processes;
- сеть: трафик, utilization, errors/discards, status интерфейсов, температура;
- ИБП: load, battery charge/runtime, input/output, bypass и alarms;
- период и aggregation выбираются явно; отсутствие данных отличается от нуля.

### Problems и Timeline

Активные и исторические события, acknowledge/comment, maintenance, provisioning
operations и audit changes в общей временной шкале.

### Configuration

Применённая policy, templates, macros без секретных значений, interfaces,
credential profile reference, discovery result и последняя reconciliation.

## Раздел «Настройки»

Левая навигация содержит:

| Раздел | Назначение | Минимальная роль |
|---|---|---|
| Площадки | timezone, proxy, network allowlist, owners | admin |
| Устройства | каталог, CSV import, archive, resync | operator |
| Профили подключения | SNMP/agent/IPMI, проверка, ротация | admin |
| Политики мониторинга | match rules, templates, macros, intervals | admin |
| Zabbix | API endpoint, service account test, capability status | admin |
| Уведомления | каналы, escalation policy, test message | admin |
| Пользователи и роли | accounts, OIDC groups, permissions | admin |
| Maintenance | recurring и разовые окна | operator |
| Аудит | кто/что/когда изменил, export | admin |
| Система | version, dependency health, backup age, storage | admin |

## Мастер «Добавить устройство»

Мастер открывается из dashboard и каталога, не требует знания терминов Zabbix.

```text
Основное → Подключение → Проверка → Рекомендация → Применение
```

### Основное

Обязательные поля: площадка, имя, IP/FQDN, тип. Proxy выбирается автоматически по
площадке. При вводе API проверяет дубликаты адреса и имени.

### Подключение

Пользователь выбирает сохранённый профиль. Создание профиля доступно inline
только admin. Форма меняется по протоколу и объясняет, какие порты открыть.

### Проверка

Каждый уровень показывается отдельно: DNS → route/ICMP → protocol → auth →
identity. Ошибка содержит полезную причину и действие, например «UDP/161 не
ответил — проверьте ACL между proxy и устройством», без вывода credential data.

### Рекомендация

UI показывает найденную модель, выбранную policy, templates и собираемые группы
метрик. Advanced settings свёрнуты. Предупреждения требуют явного принятия.

### Применение

Progress отображает шаги `create host`, `link templates`, `set macros`,
`wait for data`. Закрытие окна не отменяет job; её можно найти в Operations.
Успех ведёт в карточку устройства, частичный сбой — в диагностику и retry.

## Массовое добавление

CSV проходит тот же plan/apply pipeline. Сначала отображается preview с валидными
строками, дубликатами и ошибками; пользователь может применить только валидные.
Ограничение batch и concurrency защищает Zabbix API. Результат доступен для
скачивания без секретных данных.

Минимальные колонки CSV:

```csv
name,address,site,device_type,credential_profile,policy
sw-msk-01,10.10.1.10,msk-office,switch,snmp-core,network-auto
ups-msk-01,10.10.2.10,msk-dc,ups,snmp-ups,ups-auto
```

## Состояния и ошибки

- skeleton только для первого чтения; дальнейшие refresh сохраняют контент;
- empty state объясняет следующий шаг, а не показывает пустую таблицу;
- stale cache маркируется временем и баннером зависимости;
- 403 скрывает недоступное действие, но прямой URL всё равно проверяет backend;
- validation errors привязаны к полям и имеют общий request ID;
- destructive actions называют конкретный объект и последствия.

## Приёмочные сценарии UI

1. Оператор добавляет типовой switch, не открывая Zabbix UI, и видит первые
   метрики либо точную диагностику.
2. Повтор apply после network timeout не создаёт второй host.
3. Viewer не видит secret fields и изменяющие действия.
4. Потеря Zabbix API не обнуляет показатели, а помечает их как устаревшие.
5. Клик по числу High problems открывает список с тем же site/time filter.
6. Пользователь с клавиатурой проходит мастер; статусы понятны без различения
   цветов.
