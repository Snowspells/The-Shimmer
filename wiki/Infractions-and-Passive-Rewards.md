# Infractions and Passive Rewards

## Passive rewards
`config/passive.json` controls the reward given every `intervalMinutes` (must divide 60; ticks align to the top of the hour) to each online, linked player:

- `growth` / `marks`: `{min, max}` amounts per tick.
- `buffs`: `count` random picks from `pool` (`{attribute, min, max}`), applied with `addattr`. Attributes must exist in `config/echo/attributes.json`.
- `enabled`: turn the system off.

Growth is applied through `addattr {agid} Growth {value}` and Marks are added directly to the player's balance.

## Infractions
- Players report in game; the report webhook posts to `PLAYER_REPORT_CHANNEL_ID`. If your server's format differs, set `POT_REPORT_REGEX` (named groups `reporter`, `reporterAgid`, `target`, `targetAgid`, `reason`, optional `details`).
- Report options are the JSON files in `config/infractions/report-options/` (file name = option name). Unknown reasons are filed as "Other".
- Staff in Training and above judge reports at **Admin > Reports & Appeals**: Behavioral, Gameplay (points in `config/infractions/settings.json` under `judgements`) or Dismiss.
- `maxInfractions` (default 6) active points means a permanent game ban, lifted automatically when points fall below it. Bans are re-checked every 5 minutes.
- When a player reaches `alertThreshold` (default 3), the Owner and Staff Head role members and `DEVELOPER_USER_ID` receive a DM.
- All staff levels (Staff in Training and above) are exempt; reports against them are excluded.
- Players see their infractions at `/infractions` and can appeal each one once. Staff and above approve (removing the infraction) or deny.

Requires RCON commands `addattr` and `unban` (override with `RCON_CMD_ADDATTR`, `RCON_CMD_UNBAN`).
