import { mount } from "svelte";
import "@xyflow/svelte/dist/style.css";
import App from "./App.svelte";
import "./app.css";

const app = mount(App, { target: document.getElementById("app") });
export default app;
