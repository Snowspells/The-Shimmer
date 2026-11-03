# Ticketing System

New support requests use a private Discord DM conversation shared with the website's **Live Communication** page. Existing channel-based tickets and their saved transcripts are retained as read-only history.

## Creating tickets

Members can start a ticket in either way:

- Click **Create Ticket** on a Discord panel posted with `/ticketsetup panel`.
- Select `/ticket create` in the configured server.
- Use **Open Ticket** on the website's `/tickets` page.

The bot must be able to send direct messages to the member. Each member may have one open DM ticket at a time; they must close it before opening another, so replies received in DMs always map to the correct ticket.

## Live Communication

The `/tickets` page is titled **Live Communication**.

- Members see only their own tickets, can create or close an open ticket, and can view the transcript of a closed ticket. Anyone closing a ticket must provide a reason.
- Staff in Training and higher can view, respond to, and close tickets from the staff inbox; staff must also provide a close reason.
- Replies made by the member in Discord DMs or on the website are saved to the same conversation.
- Staff replies entered on the website are delivered to the member by DM.
- Open conversation pages poll for new messages; the staff inbox refreshes periodically.
- Closing a DM ticket saves an HTML transcript containing the close reason, sends the reason and transcript to the ticket creator by DM, and records the reason in the ticket log. The ticket and stored messages remain available in history.
- Old channel tickets are available as read-only history and cannot be changed through the new workflow.

## Ticket panel setup

An Owner or Developer can configure and post a panel using `/ticketsetup panel`. The panel can be posted in a text channel visible to members. `/ticketsetup welcome-message` controls the opening DM text; `/ticketsetup log-channel` sets the per-server channel for ticket event logs. For example, choose `#ticket-logs` in `/ticketsetup log-channel`. This setting is stored in the bot database, not `.env`. Closing a ticket saves an HTML transcript and sends it to the ticket creator as a DM attachment. Category and support-role settings are retained for legacy configuration but are not used for DM tickets.

The bot needs View Channel, Send Messages, and Embed Links in the channel where a panel is posted. The member must allow DMs from the server. The bot no longer needs Manage Channels to create new tickets.

## Existing channel tickets

Existing rows are migrated by adding `ticket_mode='channel'`. They and any saved HTML transcripts remain stored and visible to their creator and support staff. Legacy close buttons and channel-management commands no longer modify these tickets.

## Database tables

| Table | Purpose |
|---|---|
| `tickets` | Ticket metadata, owner, status, and mode (`channel` for old tickets, `dm` for new tickets) |
| `ticket_messages` | Persistent messages in new DM-backed conversations |
| `ticket_settings` | Existing per-guild ticket panel, log-channel, and welcome-text settings |
| `ticket_transcripts` | Saved HTML transcript and message count |
