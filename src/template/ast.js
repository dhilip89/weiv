import _ from 'lodash'
import vdom from 'virtual-dom'
import Jexl from 'jexl-sync'
import debug from 'debug'
import { HTML_EVENT_ATTRIBUTES } from './html'

const log = debug('weiv:render')

export class Expression {
  constructor(exp) {
    this.exp = exp
    this.ast = Jexl.parse(exp)
  }

  eval(component) {
    let val = Jexl.evaluate(this.ast, component)
    log('Evaluate expression `%s`: %o', this.exp, val)
    // autobind functions
    if (val && typeof val === 'function') {
      val = val.bind(component)
    }
    return val
  }

  render(component) {
    console.group('%o', this)
    const val = this.eval(component)
    const text = (val !== null && val !== undefined) ? String(val) : ''
    console.groupEnd()
    return new vdom.VText(text)
  }
}

const STRUCTRUAL_DIRECTIVES = [
  'if',
  'else-if',
  'else'
]

const BEHAVIORAL_DIRECTIVES = [
  'bind',
  'on'
]

const STRUCTRUAL_DIRECTIVE = 0
const BEHAVIORAL_DIRECTIVE = 1

class Directive {
  constructor(command, target, params, exp) {
    this.command = command.toLowerCase()
    this.target = target
    this.params = params
    this.expression = new Expression(exp)
    if (_.includes(STRUCTRUAL_DIRECTIVES, this.command)) {
      this.type = STRUCTRUAL_DIRECTIVE
    } else if (_.includes(BEHAVIORAL_DIRECTIVES, this.command)) {
      this.type = BEHAVIORAL_DIRECTIVE
    } else {
      throw new Error(`Illegal directive: '${this.command}'`)
    }
  }

  static isTrue(val) {
    if (val === false || val === null || val === undefined) return false
    return true
  }
}

export class Text {
  constructor(text) {
    this.text = text
  }

  render(component) {
    console.log('%o', this)
    return new vdom.VText(this.text)
  }
}

function parseDirective(name, exp) {
  const pattern = /@(\w+)(:(\w+)((\.\w+)*))?/
  const m = name.match(pattern)
  if (m) {
    let params = []
    if (m[4]) {
      params = _.remove(m[4].split('.'), null)
    }
    return new Directive(m[1], m[3], params, exp)
  }
  throw new Error(`Illagal directive attribute format: ${name}`)
}

export class Node {
  constructor(tagName, attributes) {
    this.tagName = tagName.toLowerCase()
    this.properties = {}
    this.directives = []
    this.children = []
    this.parent = null
    for (let name of Object.keys(attributes)) {
      if (name.match(/@[^@]+/)) { // directive prefix: @
        const directive = parseDirective(name, attributes[name])
        if (directive) this.directives.push(directive)
      } else if (_.includes(HTML_EVENT_ATTRIBUTES, name.toLowerCase())) {
        this.properties[name] = new Expression(attributes[name])
      } else {
        this.properties[name] = attributes[name]
      }
    }
  }

  closestComponent() {
    let node = this
    while (node != null) {
      /* eslint no-use-before-define: 0*/
      if (node instanceof Component) return node
      node = node.parent
    }
    return null
  }

  previousSiblingNode() {
    if (this.parent === null) return null
    const index = _.indexOf(this.parent.children, this)
    if (index === 0) return null
    return this.parent.children[index - 1]
  }

  nextSiblingNode() {
    if (this.parent === null) return null
    const index = _.indexOf(this.parent.children, this)
    if (index === this.parent.children.length - 1) return null
    return this.parent.children[index + 1]
  }

  // structural directive
  _structural(directive, properties, children, component) {
    const val = directive.expression.eval(component)
    if (directive.command === 'if') {
      return Directive.isTrue(val)
    }
    return true
  }

  // behavioral directive
  _behavioral(directive, properties, children, component) {
    const val = directive.expression.eval(component)
    if (directive.command === 'bind') {
      properties[directive.target] = val
    } else if (directive.command === 'on') {
      if (val && typeof val === 'function') {
        if (_.includes(HTML_EVENT_ATTRIBUTES, 'on' + directive.target.toLowerCase())) {
          properties[`on${directive.target}`] = val
        }
      }
    }
  }

  render(component) {
    console.group('%o', this)
    let properties = _.cloneDeep(this.properties)
    // only `onclick..` attributes is expression
    properties = _.mapValues(properties, attr => attr instanceof Expression ? attr.eval(component) : attr)
    const children = _.compact(_.flatMap(this.children, child => child.render(component)))
    // start directiv processing
    const structualDirectives = this.directives.filter(directive => directive.type === STRUCTRUAL_DIRECTIVE)
    const behavioralDirectives = this.directives.filter(directive => directive.type === BEHAVIORAL_DIRECTIVE)
    for (let directive of structualDirectives) {
      if (!this._structural(directive, properties, children, component)) return null
    }
    for (let directive of behavioralDirectives) {
      this._behavioral(directive, properties, children, component)
    }
    console.groupEnd()
    return vdom.h(this.tagName, properties, children)
  }
}

export class Slot extends Node {
  constructor(tagName, attributes) {
    super(tagName, attributes)
    this.name = attributes.name || 'default'
  }

  render(component) { // return
    console.group('%o', this)
    let properties = _.cloneDeep(this.properties)
    // only `onclick..` attributes is expression
    properties = _.mapValues(properties, attr => attr instanceof Expression ? attr.eval(component) : attr)
    const children = _.compact(_.flatMap(this.children, child => child.render(component)))
    // start directiv processing
    const structualDirectives = this.directives.filter(directive => directive.type === STRUCTRUAL_DIRECTIVE)
    const behavioralDirectives = this.directives.filter(directive => directive.type === BEHAVIORAL_DIRECTIVE)
    for (let directive of structualDirectives) {
      if (!this._structural(directive, properties, children, component)) return null
    }
    for (let directive of behavioralDirectives) {
      this._behavioral(directive, properties, children, component)
    }
    console.groupEnd()
    if (component.$vslots.has(this.name) && !_.isEmpty(component.$vslots.get(this.name))) {
      return component.$vslots.get(this.name)
    }
    return children
  }
}

export class Component extends Node {
  constructor(tagName, attributes, componentClass) {
    super(tagName, attributes)
    this.componentClass = componentClass
    this.componentId = componentClass.$original.$uniqueid()
    for (let name of Object.keys(attributes)) {
      if (name.match(/@[^@]+/)) { // directive prefix: @
        const directive = parseDirective(name, attributes[name])
        if (directive) this.directives.push(directive)
      } else {
        // validate component props
        if (_.includes(Object.keys(componentClass.prototype.$props), name)) {
          this.properties[name] = attributes[name]
        } else {
          console.warn('Illegal commponent props %s in %s', name, componentClass.$class.name)
        }
      }
    }
  }

  // structural directive
  _structural(directive, properties, children, component) {
    if (directive.command === 'if') {
      const val = directive.expression.eval(component)
      return Directive.isTrue(val)
    }
    return true
  }

  // behavioral directive
  _behavioral(directive, properties, children, component, childComponent) {
    const val = directive.expression.eval(component)
    if (directive.command === 'bind') {
      properties[directive.target] = val
    } else if (directive.command === 'on') {
      if (val && typeof val === 'function') {
        if (_.includes(directive.params, 'native')) {
          if (_.includes(HTML_EVENT_ATTRIBUTES, directive.target.toLowerCase())) {
            // TODO add native event to component's root dom element from its template
          }
        } else {
          childComponent.$on(directive.target, val)
        }
      }
    } else {
      console.error('Illegal directive: %o', directive)
    }
  }

  render(component) {
    console.group('%o', this)
    let properties = _.cloneDeep(this.properties)
    // only `onclick..` attributes is expression
    properties = _.mapValues(properties, prop => prop instanceof Expression ? prop.eval(component) : prop)
    const children = _.compact(_.flatMap(this.children, child => child.render(component)))
    // start directive processing
    const structualDirectives = this.directives.filter(directive => directive.type === STRUCTRUAL_DIRECTIVE)
    const behavioralDirectives = this.directives.filter(directive => directive.type === BEHAVIORAL_DIRECTIVE)
    for (let directive of structualDirectives) {
      if (!this._structural(directive, properties, children, component)) return null
    }

    /* eslint new-cap: 0 */
    let childComponent = component.$children.get(this.componentId)
    if (!childComponent) {
      childComponent = new this.componentClass(this.componentId, component)
    }
    // process childrent to fill slots
    children.forEach(child => {
      const slot = _.has(child.properties, 'slot') ? child.properties['slot'] : 'default'
      if (childComponent.$vslots.has(slot)) {
        childComponent.$vslots.get(slot).push(child)
      } else {
        console.warn('Fail to find slot %j in component %s template', slot, this.componentClass.$original.name)
      }
    })
    childComponent.$emitter.removeAllListeners()
    for (let directive of behavioralDirectives) {
      this._behavioral(directive, properties, children, component, childComponent)
    }
    childComponent.$render(properties)
    childComponent.$vdom.properties.id = this.componentId // attach an id attribute
    console.groupEnd()
    return childComponent.$vdom
  }
}
