require('dotenv').config();

const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');

const commands = require('./commands');

if (!process.env.TOKEN) {
  throw new Error('Missing TOKEN in .env');
}

if (!process.env.CLIENT_ID) {
  throw new Error('Missing CLIENT_ID in .env');
}

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
const commandPayload = commands.map((command) => command.toJSON());

(async () => {
  let cleanupClient = null;

  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commandPayload
    });

    cleanupClient = new Client({
      intents: [GatewayIntentBits.Guilds]
    });

    await cleanupClient.login(process.env.TOKEN);
    await new Promise((resolve) => cleanupClient.once('clientReady', resolve));

    for (const guild of cleanupClient.guilds.cache.values()) {
      await guild.commands.set([]);
      console.log(`Cleared guild-specific commands in ${guild.name}.`);
    }

    console.log('Commands deployed successfully and stale guild commands were cleared.');
  } catch (error) {
    console.error('Failed to deploy commands:', error);
    process.exitCode = 1;
  } finally {
    if (cleanupClient) {
      await cleanupClient.destroy();
    }
  }
})();
