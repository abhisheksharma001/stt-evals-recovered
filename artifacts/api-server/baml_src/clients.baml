// The judge's default LLM client. The API key is read from the process
// environment at call time -- never stored, never sent to the browser, same
// rule as every other key in this repo. routes can override the model per
// app_settings.agentModel at runtime through a ClientRegistry (see
// src/lib/agent.ts); this declaration is only the default.
client<llm> Judge {
  provider openai
  options {
    model "gpt-4o"
    api_key env.OPENAI_API_KEY
  }
}

// T-102: the failure-triage client. Cheap model, same back-off as the judge.
client<llm> Triage {
  provider openai
  retry_policy JudgeRetry
  options {
    model "gpt-4o-mini"
    api_key env.OPENAI_API_KEY
  }
}
