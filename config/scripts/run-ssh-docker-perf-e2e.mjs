#!/usr/bin/env node
import { runSshNativeGate } from './run-ssh-native-gate.mjs'

process.exit(runSshNativeGate({ profile: 'relay-performance' }))
