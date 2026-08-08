import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { logoutAgent } from '../mindcraft/mindserver.js';

const init_agent_path = fileURLToPath(new URL('./init_agent.js', import.meta.url));

export class AgentProcess {
    /** An agent that survives this long is considered to have started cleanly. */
    static HEALTHY_UPTIME_MS = 30000;
    /** Roughly 10 minutes of retries at the capped delay before giving up. */
    static MAX_FAST_FAILURES = 12;
    static BASE_BACKOFF_MS = 5000;
    static MAX_BACKOFF_MS = 60000;

    constructor(name, port) {
        this.name = name;
        this.port = port;
    }

    start(load_memory=false, init_message=null, count_id=0) {
        this.count_id = count_id;
        this.running = true;

        let args = [init_agent_path, this.name];
        args.push('-n', this.name);
        args.push('-c', count_id);
        if (load_memory)
            args.push('-l', load_memory);
        if (init_message)
            args.push('-m', init_message);
        args.push('-p', this.port);

        const agentProcess = spawn(process.execPath, args, {
            stdio: 'inherit',
            stderr: 'inherit',
        });
        
        let last_restart = Date.now();
        agentProcess.on('exit', (code, signal) => {
            console.log(`Agent process exited with code ${code} and signal ${signal}`);
            this.running = false;
            logoutAgent(this.name);
            
            if (code > 1) {
                console.log(`Ending task`);
                process.exit(code);
            }

            if (code !== 0 && signal !== 'SIGINT') {
                const uptime = Date.now() - last_restart;

                // A short life means the world was not ready, not that the agent
                // is broken -- most often the Minecraft server is still booting.
                //
                // Giving up permanently after ONE fast failure (the previous
                // behaviour) makes an ordinary server restart fatal: the agents
                // die, one retry races the server's ~15s startup, fails, and the
                // village is abandoned while the process stays alive looking
                // healthy. Back off and keep trying instead; a run of decent
                // length clears the counter.
                if (uptime >= AgentProcess.HEALTHY_UPTIME_MS) {
                    this.fast_failures = 0;
                }

                if (uptime < AgentProcess.HEALTHY_UPTIME_MS) {
                    this.fast_failures = (this.fast_failures || 0) + 1;

                    if (this.fast_failures > AgentProcess.MAX_FAST_FAILURES) {
                        console.error(
                            `Agent ${this.name} failed ${this.fast_failures} times in quick succession; giving up. ` +
                            `Check that the Minecraft server is reachable.`
                        );
                        return;
                    }

                    const delay = Math.min(
                        AgentProcess.BASE_BACKOFF_MS * 2 ** (this.fast_failures - 1),
                        AgentProcess.MAX_BACKOFF_MS
                    );
                    console.warn(
                        `Agent ${this.name} exited after ${(uptime / 1000).toFixed(1)}s ` +
                        `(attempt ${this.fast_failures}/${AgentProcess.MAX_FAST_FAILURES}); ` +
                        `retrying in ${delay / 1000}s.`
                    );
                    setTimeout(() => {
                        last_restart = Date.now();
                        this.start(true, 'Agent process restarted.', count_id);
                    }, delay);
                    return;
                }

                console.log('Restarting agent...');
                last_restart = Date.now();
                this.start(true, 'Agent process restarted.', count_id);
            }
        });
    
        agentProcess.on('error', (err) => {
            console.error('Agent process error:', err);
        });

        this.process = agentProcess;
    }

    stop() {
        if (!this.running) return;
        this.process.kill('SIGINT');
    }

    forceRestart() {
        if (this.running && this.process && !this.process.killed) {
            console.log(`Agent process for ${this.name} is still running. Attempting to force restart.`);
            
            const restartTimeout = setTimeout(() => {
                console.warn(`Agent ${this.name} did not stop in time. It might be stuck.`);
            }, 5000); // 5 seconds to exit

            this.process.once('exit', () => {
                 clearTimeout(restartTimeout);
                 console.log(`Stopped hanging agent ${this.name}. Now restarting.`);
                 this.start(true, 'Agent process restarted.', this.count_id);
            });
            this.stop(); // sends SIGINT
        } else {
             this.start(true, 'Agent process restarted.', this.count_id);
        }
    }
}