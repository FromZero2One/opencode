import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  override emit<K>(eventName: K | "event", ...args: K extends "event" ? [GlobalEvent] : never): boolean {
    if (eventName === "event") {
      const event = args[0] as GlobalEvent
      if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
        event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
      }
    }
    return super.emit<K>(eventName, ...args)
  }
}

export const GlobalBus = new GlobalBusEmitter()
