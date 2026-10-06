# Staff Access

Website and restricted bot-command access are determined by a member's current roles in `STAFF_GUILD_ID`, except Developer access, which is assigned directly by Discord user ID. Configure the three staff roles and `DEVELOPER_USER_ID` in `.env`. The bot must be a member of that guild, and the Server Members Intent must be enabled. Protected website actions and restricted commands resolve current access rather than trusting the state stored at login.

## Role levels

If a member has more than one configured role, only the highest level applies:

| Level | Environment variable | Access |
|---|---|---|
| Member | — | Their own account data, inventory, marks, and tickets |
| Staff in Training | `STAFF_IN_TRAINING_ROLE_ID` | Member access plus view, respond to, and close other members' tickets |
| Staff | `STAFF_ROLE_ID` | Staff in Training access plus web-chat moderation, RCON controls, and linked-member/account management |
| Owner | `OWNER_ROLE_ID` | Staff access plus the existing `/reload` command |
| Developer | `DEVELOPER_USER_ID` | All website capabilities and all bot commands; this specific user ID takes precedence over role-based levels |

The `/reload` command reloads command definitions; it does not dynamically unload and reload arbitrary runtime plugins. `botOwner`-restricted setup commands are available to Owner and the configured Developer. Commands explicitly restricted to Developers require the configured Developer user ID.

## Configuration

```env
STAFF_GUILD_ID=your_discord_server_id
STAFF_IN_TRAINING_ROLE_ID=your_staff_in_training_role_id
STAFF_ROLE_ID=your_staff_role_id
OWNER_ROLE_ID=your_owner_role_id
DEVELOPER_USER_ID=your_discord_user_id
```

To copy an ID, enable Developer Mode in Discord, right-click the server or staff role, and select **Copy ID**. For `DEVELOPER_USER_ID`, right-click the Developer's Discord user profile and select **Copy User ID**. Empty role IDs grant no access at that level. If Discord membership cannot be verified for a role-protected action, access is denied and the failure is logged.

## Legacy `/staffrole` command

The `/staffrole` command only edits the legacy `staff_roles` database table; these records no longer grant website or bot-command access. Configure active access with the environment variables above.
