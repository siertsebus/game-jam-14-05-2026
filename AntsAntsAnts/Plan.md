Lazy Queen

In this game, you have a flat top down game.


The game should be a GPU simulation of ants. The GPU sim should run via web gpu. 

The compute shader should render the ants onto the texture (we should have a render texture as the field).

We should have a number of other textures, that we use as various pheronmons. 

The ants should move, depending on the phermons in there vicinity. 

Each ant should have various sensors, x angle away from forward, and depending on the values of the various phermones. They should change there steering behaviour. 

We will add more things that will make ants release phermons.


For example, we should have a death texture, if an ant gets there. It dies, and it shoud release a death phermon. 

How fast it decepates, how much gets released is dependent on some values. 


Each shader should be in its own script.

The logic should heavily depend on the shaders, and things interacting with the texture as a medium. 

For example, to prevent ants from clumping, we need to have a texture, where ants release a phermon where they are. 

Then ants should avoid being too close to this.

But ants should try to walk behind other ants a little, not too much, but a little. 

etc, etc... 

We will modify the other rules as we go. 

Each phermon should be displayed as a various color. Thats what the user should see

Leaving texture is death, so any ant that leaves the texture, should leave death phermon and die in the last in screen position.


We will add more phermons and stuff later, please make sure things are seperated into scripts. Same with different manager javascript scripts.