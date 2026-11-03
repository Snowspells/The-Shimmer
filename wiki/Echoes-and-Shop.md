# Echoes and Shop

Everything here is configured with JSON files under `config/` (override the location with `CONFIG_DIR`). The file name, without `.json`, is the item name. Add a file to add an entry and delete it to remove one; changes apply without a restart.

```
config/
  echo/
    tiers.json            tier folders, display names and break chances
    attributes.json       the /setattr attributes an Echo may set (whitelist)
    Echo Fragments/       Endurance Fragment.json, ...
    Echo Shards/          Endurance Shard.json, ...
    Echo Cores/           Endurance Core.json, ...
    species/              Allosaurus.json, ...  (species that can be assigned Echoes)
  shop/
    <Category>/           <Item>.json  { "price": 100, "description": "...", "echo": { "tier": "Echo Fragments", "name": "Endurance Fragment" } }
```

- Each Echo file lists every attribute. `null` means "not applied"; a number is sent through `/setattr`. If several equipped Echoes set the same attribute, the values multiply.
- A player can equip one Echo per tier on each species, from the **Echoes** page. When that species dies, each equipped Echo can break and is deleted from the inventory and assignment: Fragment 50%, Shard 25%, Core 10% (`tiers.json`).
- When a player is seen in-game as an assigned species, the bot sends the `setattr` commands and whispers the equipped Echo names.
- Shop items cost Marks. Items with an `echo` field grant that Echo; others add a named item to the inventory.

## Death detection

Deaths are inferred by polling the RCON player list every `ECHO_POLL_INTERVAL_MS` (default 5000). A death is a player flagged dead/at 0 health, or a species change while online. The list format depends on the game version, so the parsers are overridable with `POT_PLAYERLIST_AGID_REGEX`, `POT_PLAYERLIST_SPECIES_REGEX` and `POT_PLAYERLIST_DEAD_REGEX`. The `setattr` command template is `RCON_CMD_SETATTR` (default `setattr {agid} {attribute} {value}`).
