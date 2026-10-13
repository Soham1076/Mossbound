# Mossbound

A procedural 2D multiplayer survival game with a shared, endless world. It uses only Node.js built-ins, so there is nothing to install.

## Play solo or with a friend

1. On the computer that will host the game, run `start-game.cmd` (or `node server.js`).
2. Open [http://localhost:8080](http://localhost:8080) on that computer.
3. To play solo, choose Easy, Medium, or Hard bot before entering. To play with a friend, leave **Wait for a friend** selected. Put both devices on the same Wi-Fi network; on the second device, open the **LAN address** shown on the host screen. If the address is not shown, use the host computer's local IPv4 address with `:8080` (for example, `http://192.168.1.42:8080`).
4. Allow Node.js through the host computer's private-network firewall if Windows asks.

The game server listens on all network interfaces at port `8080`. Players share the same world and two-minute round. The clock starts when a second player or bot joins. If a friend joins while a bot match is waiting or running, the bot steps aside for the two human players.

After the results appear, either player can choose **Restart game**. This resets the shared world and returns connected devices to the main menu with a fresh timer and empty packs.

## Publish a 24/7 website

The repository includes a Render Blueprint in `render.yaml` for the always-on Node.js game server. To publish it, create a Render account, choose **New → Blueprint**, connect `Soham1076/Mossbound`, and review the service before deploying. Render will provide a public HTTPS address that players can open from separate devices. Later pushes to `main` deploy automatically.

The Blueprint uses one Singapore server instance because the shared match state is held in that server's memory. The smallest Render plan that stays on is currently **$7 USD/month**; Render's free web service sleeps after 15 minutes without incoming traffic, so it does not meet the 24/7 requirement. The Hobby workspace is free, but bandwidth above its included allowance may cost extra. A server restart or code deploy clears the current in-memory match and world; player accounts and long-term saves are not part of the game yet.

## Controls

- **WASD** or **arrow keys** — move
- **I** — attack the nearest player or resource
- **O** — collect nearby drops
- **P** — emote (“Yeah!” / “GG”)
- Touch devices also get an on-screen movement pad and action buttons.

Wood and stone increase your attack damage. Attacks can knock a resource out of another player; a defeated player's remaining pack drops where they fell. Collect gold and diamonds to win when the two-minute round ends. Players respawn after three seconds near their fall point.

## Run from a terminal

```sh
node server.js
```

Then visit `http://localhost:8080`. Stop the host with **Ctrl+C**.

