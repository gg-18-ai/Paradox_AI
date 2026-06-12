import sys
import json
import asyncio
import os
import argparse
import base64
from browser_use import Agent, Browser, ChatGroq

def send_event(event, data):
    print(json.dumps({"event": event, "data": data}), flush=True)

async def main():
    parser = argparse.ArgumentParser(description="Browser Use Subprocess Agent")
    parser.add_argument("--task", type=str, required=True, help="The task to perform")
    parser.add_argument("--headless", action="store_true", help="Run browser in headless mode")
    args = parser.parse_args()

    task = args.task
    headless = args.headless

    send_event("log", f"Task received: {task}")
    send_event("log", "Browser Use started")

    # Get API key
    groq_api_key = os.environ.get("GROQ_API_KEY")
    if not groq_api_key:
        send_event("error", "GROQ_API_KEY environment variable is not defined.")
        sys.exit(1)

    try:
        # Initialize Groq LLM using browser_use's own ChatGroq wrapper with a monkey patch to support tool-calling models
        import browser_use.llm.groq.chat as gc
        if 'llama-3.3-70b-versatile' not in gc.ToolCallingModels:
            gc.ToolCallingModels.append('llama-3.3-70b-versatile')
        if 'llama-3.1-8b-instant' not in gc.ToolCallingModels:
            gc.ToolCallingModels.append('llama-3.1-8b-instant')

        async def patched_invoke_structured_output(self, groq_messages, output_format):
            print("[MonkeyPatch] Entering patched_invoke_structured_output", flush=True)
            schema = gc.SchemaOptimizer.create_optimized_json_schema(output_format)
            if self.model in gc.ToolCallingModels:
                print(f"[MonkeyPatch] Calling _invoke_with_tool_calling for model {self.model}", flush=True)
                response = await self._invoke_with_tool_calling(groq_messages, output_format, schema)
                print("[MonkeyPatch] Received response from tool calling", flush=True)
                message = response.choices[0].message
                if message.tool_calls:
                    content = message.tool_calls[0].function.arguments
                else:
                    content = message.content
            else:
                print(f"[MonkeyPatch] Calling _invoke_with_json_schema for model {self.model}", flush=True)
                response = await self._invoke_with_json_schema(groq_messages, output_format, schema)
                print("[MonkeyPatch] Received response from json schema", flush=True)
                content = response.choices[0].message.content
            print(f"[MonkeyPatch] Parsing content (len={len(content) if content else 0})", flush=True)
            if not content:
                raise gc.ModelProviderError(
                    message='No content in response (neither message content nor tool calls)',
                    status_code=500,
                    model=self.name,
                )
            parsed_response = output_format.model_validate_json(content)
            usage = self._get_usage(response)
            print("[MonkeyPatch] Validation successful, returning completion", flush=True)
            return gc.ChatInvokeCompletion(completion=parsed_response, usage=usage)

        gc.ChatGroq._invoke_structured_output = patched_invoke_structured_output

        llm = ChatGroq(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            temperature=0.0,
            api_key=groq_api_key
        )

        # Configure browser directly through Browser constructor with robust Chrome support and longer wait times
        from browser_use.browser.profile import BrowserProfile
        
        # Monkey patch BrowserProfile.get_args to prevent browser-use from overwriting our extension load args
        original_get_args = BrowserProfile.get_args
        
        def patched_get_args(self):
            args = original_get_args(self)
            
            # Find --load-extension
            load_ext_idx = -1
            for i, arg in enumerate(args):
                if arg.startswith('--load-extension='):
                    load_ext_idx = i
                    break
            
            current_dir = os.path.dirname(os.path.abspath(__file__))
            ext_path = os.path.join(current_dir, "extension")
            
            if load_ext_idx != -1:
                # Add our extension to the list if not already present
                existing_paths = args[load_ext_idx].split('=', 1)[1].split(',')
                if ext_path not in existing_paths:
                    existing_paths.append(ext_path)
                    args[load_ext_idx] = f"--load-extension={','.join(existing_paths)}"
            else:
                args.append(f"--load-extension={ext_path}")
                
            # Find or add --disable-extensions-except
            except_idx = -1
            for i, arg in enumerate(args):
                if arg.startswith('--disable-extensions-except='):
                    except_idx = i
                    break
            
            # Get all loaded extension paths
            loaded_paths = []
            if load_ext_idx != -1:
                loaded_paths = args[load_ext_idx].split('=', 1)[1].split(',')
            else:
                loaded_paths = [ext_path]
                
            if except_idx != -1:
                existing_except = args[except_idx].split('=', 1)[1].split(',')
                for path in loaded_paths:
                    if path not in existing_except:
                        existing_except.append(path)
                args[except_idx] = f"--disable-extensions-except={','.join(existing_except)}"
            else:
                args.append(f"--disable-extensions-except={','.join(loaded_paths)}")
                
            return args
            
        BrowserProfile.get_args = patched_get_args

        try:
            browser = Browser(
                headless=headless,
                disable_security=True,
                channel="chrome",
                minimum_wait_page_load_time=1.5,
                wait_for_network_idle_page_load_time=2.0,
                wait_between_actions=1.0
            )
        except Exception:
            browser = Browser(
                headless=headless,
                disable_security=True,
                minimum_wait_page_load_time=1.5,
                wait_for_network_idle_page_load_time=2.0,
                wait_between_actions=1.0
            )

        # Step callback to output logs and screenshots in real-time
        def step_callback(state, model_output, step_number=None):
            # Extract action description
            action_desc = "Thinking and planning next step..."
            if model_output:
                try:
                    # browser-use models have structured thoughts or actions
                    if hasattr(model_output, 'text') and model_output.text:
                        action_desc = model_output.text
                    elif hasattr(model_output, 'reasoning') and model_output.reasoning:
                        action_desc = model_output.reasoning
                    else:
                        action_desc = str(model_output)
                except Exception:
                    pass
            
            send_event("log", f"Browser Use action: {action_desc}")

            # Send screenshot if present in state
            if state and hasattr(state, 'screenshot') and state.screenshot:
                try:
                    if isinstance(state.screenshot, bytes):
                        scr_b64 = base64.b64encode(state.screenshot).decode('utf-8')
                    else:
                        scr_b64 = str(state.screenshot)
                    send_event("screenshot", scr_b64)
                except Exception as e:
                    send_event("log", f"[Warning] Failed to encode step screenshot: {str(e)}")

        # Initialize and run agent
        agent = Agent(
            task=task,
            llm=llm,
            browser=browser,
            use_vision=False,
            register_new_step_callback=step_callback
        )

        result = await agent.run()

        # Extract completion reasoning/result
        final_msg = "Task completed successfully."
        if result:
            try:
                final_msg = str(result)
            except Exception:
                pass
        
        send_event("log", "Task completed")
        send_event("complete", final_msg)

    except Exception as e:
        send_event("log", "Error occurred")
        send_event("error", str(e))
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
