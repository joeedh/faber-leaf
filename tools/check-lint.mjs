import child_process from 'node:child_process'

const run = (command) => {
  try {
    child_process.execSync(command, {stdio: 'inherit'})
  } catch (error) {
    console.error(`Error executing command: ${command}`)
    process.exit(1)
  }
}

run('pnpm lint:prose')
run('pnpm lint:eslint')
